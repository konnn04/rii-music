import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "@tanstack/react-router";
import type { Track } from "@/lib/api";
import { fmtDate, fmtMs } from "@/lib/format";
import { useCanHover, useIsDesktop, useIsMobile } from "@/lib/useMedia";
import { useToggleLike } from "@/lib/queries";
import { engine } from "@/player/engine";
import { usePlayback, usePlayer, type Source } from "@/player/store";
import { Cover } from "./ui/Cover";
import { Icon } from "./ui/Icon";
import { Equalizer } from "./ui/misc";
import { TrackContextMenu, TrackMenuButton } from "./TrackMenu";
import { openDialog, type TrackContext } from "./dialogs";
import { toast } from "./ui/Toast";
import { t, tn } from "@/i18n";
import { ArtistLinks } from "@/components/ArtistLinks";

/** The scrolling <main> element, so lists can virtualise against it. */
export const useScrollEl = create<{ el: HTMLElement | null }>(() => ({ el: null }));
// The DOM node exists before React attaches the ref, so fall back to it.
const getScrollEl = () => useScrollEl.getState().el ?? document.getElementById("main");

type Props = {
  tracks: Track[];
  source: Source;
  ctx?: TrackContext;
  showAlbum?: boolean;
  showAdded?: boolean;
  numbered?: boolean;
  onReorder?: (ids: string[]) => void;
  selectable?: boolean;
};

export function TrackList({ tracks, source, ctx, showAlbum = true, showAdded = false, numbered = false, onReorder, selectable = true }: Props) {
  const desktop = useIsDesktop();
  const mobile = useIsMobile();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const rowH = mobile ? 64 : 56;

  const play = useCallback(
    (i: number) => {
      const cur = usePlayer.getState().current;
      if (cur?.track.id === tracks[i].id && usePlayer.getState().source?.id === source.id && usePlayer.getState().source?.type === source.type) {
        engine.toggle();
        return;
      }
      usePlayer.getState().playList(tracks, i, source, { shuffle: false });
    },
    [tracks, source],
  );

  const toggleSel = useCallback((id: string) => {
    setSelected((s) => {
      const n = new Set(s ?? []);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }, []);

  const cols = desktop
    ? `${numbered || onReorder ? "40px " : ""}minmax(0,4fr) ${showAlbum ? "minmax(0,3fr) " : ""}${showAdded ? "112px " : ""}44px 64px 44px`
    : "";

  const header = desktop && (
    <div
      className="sticky top-[var(--spacing-topbar)] z-[5] grid h-10 items-center gap-3 border-b border-line bg-canvas px-2 text-overline uppercase text-fg-subtle"
      style={{ gridTemplateColumns: cols }}
    >
      {(numbered || onReorder) && <span className="text-center">#</span>}
      <span>{t("tracks.columns.title")}</span>
      {showAlbum && <span>{t("tracks.columns.album")}</span>}
      {showAdded && <span>{t("tracks.columns.dateAdded")}</span>}
      <span />
      <span className="text-right">
        <Icon name="history" size={16} className="ml-auto" aria-label={t("tracks.columns.duration")} />
      </span>
      <span />
    </div>
  );

  const rowProps = { cols, desktop, mobile, ctx, showAlbum, showAdded, numbered: numbered || !!onReorder, play, selected, toggleSel, setSelected, selectable };

  return (
    <div>
      {selected && <SelectionBar tracks={tracks} selected={selected} onClose={() => setSelected(null)} setSelected={setSelected} />}
      {header}
      {onReorder ? (
        <SortableRows tracks={tracks} onReorder={onReorder} rowProps={rowProps} />
      ) : (
        <VirtualRows tracks={tracks} rowH={rowH} rowProps={rowProps} />
      )}
    </div>
  );
}

type RowShared = {
  cols: string;
  desktop: boolean;
  mobile: boolean;
  ctx?: TrackContext;
  showAlbum: boolean;
  showAdded: boolean;
  numbered: boolean;
  play: (i: number) => void;
  selected: Set<string> | null;
  toggleSel: (id: string) => void;
  setSelected: (s: Set<string> | null) => void;
  selectable: boolean;
};

function VirtualRows({ tracks, rowH, rowProps }: { tracks: Track[]; rowH: number; rowProps: RowShared }) {
  const scrollEl = useScrollEl((s) => s.el) ?? getScrollEl();
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);

  useLayoutEffect(() => {
    const el = listRef.current, sc = scrollEl;
    if (!el || !sc) return;
    const measure = () => setMargin(el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc.firstElementChild ?? sc);
    return () => ro.disconnect();
  }, [scrollEl]);

  const v = useVirtualizer({
    count: tracks.length,
    getScrollElement: getScrollEl,
    estimateSize: () => rowH,
    overscan: 10,
    scrollMargin: margin,
    getItemKey: (i) => tracks[i].id,
  });

  return (
    <div ref={listRef} role="list" style={{ height: v.getTotalSize(), position: "relative" }}>
      {v.getVirtualItems().map((vi) => (
        <div key={vi.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: rowH, transform: `translateY(${vi.start - margin}px)` }}>
          <Row track={tracks[vi.index]} index={vi.index} {...rowProps} />
        </div>
      ))}
    </div>
  );
}

function SortableRows({ tracks, onReorder, rowProps }: { tracks: Track[]; onReorder: (ids: string[]) => void; rowProps: RowShared }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [items, setItems] = useState(tracks);
  const [prev, setPrev] = useState(tracks);
  if (prev !== tracks) {
    setPrev(tracks);
    setItems(tracks);
  }
  const onEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((t) => t.id === e.active.id);
    const to = items.findIndex((t) => t.id === e.over!.id);
    const next = arrayMove(items, from, to);
    setItems(next);
    onReorder(next.map((t) => t.id));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
      <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div role="list">
          {items.map((t, i) => (
            <SortableRow key={t.id} track={t} index={i} rowProps={rowProps} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ track, index, rowProps }: { track: Track; index: number; rowProps: RowShared }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: track.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 10 : undefined, position: "relative" }}
      className={isDragging ? "rounded-control bg-surface-2 shadow-float" : ""}
    >
      <Row track={track} index={index} {...rowProps} dragHandle={{ ...attributes, ...listeners }} />
    </div>
  );
}

const Row = memo(function Row({
  track,
  index,
  cols,
  desktop,
  mobile,
  ctx,
  showAlbum,
  showAdded,
  numbered,
  play,
  selected,
  toggleSel,
  setSelected,
  selectable,
  dragHandle,
}: RowShared & { track: Track; index: number; dragHandle?: Record<string, unknown> }) {
  const isCurrent = usePlayer((s) => s.current?.track.id === track.id);
  const isPlaying = usePlayback((s) => s.isPlaying);
  const canHover = useCanHover();
  const like = useToggleLike();
  const pressTimer = useRef<number | null>(null);
  const selecting = selected !== null;
  const isSel = selected?.has(track.id) ?? false;

  const onActivate = () => {
    if (selecting) toggleSel(track.id);
    else play(index);
  };

  const touchHandlers =
    selectable && !canHover
      ? {
          onTouchStart: () => {
            pressTimer.current = window.setTimeout(() => {
              pressTimer.current = null;
              navigator.vibrate?.(10);
              setSelected(new Set([track.id]));
            }, 500);
          },
          onTouchMove: () => pressTimer.current && clearTimeout(pressTimer.current),
          onTouchEnd: () => pressTimer.current && clearTimeout(pressTimer.current),
        }
      : {};

  const titleCls = `truncate text-body ${isCurrent ? "text-accent font-medium" : "text-fg"}`;

  const lead = numbered && desktop && (
    <span className="relative flex h-full items-center justify-center text-body-sm text-fg-muted tabular">
      {dragHandle ? (
        <span {...dragHandle} className="focus-ring flex size-8 cursor-grab touch-none items-center justify-center rounded-xs" aria-label={t("tracks.row.dragToReorder")}>
          <span className="group-hover:hidden">{isCurrent ? <Equalizer paused={!isPlaying} /> : index + 1}</span>
          <Icon name="grip" size={20} className="hidden group-hover:block" />
        </span>
      ) : isCurrent ? (
        <Equalizer paused={!isPlaying} />
      ) : (
        <>
          <span className="group-hover:hidden">{index + 1}</span>
          <Icon name="play" size={18} className="hidden text-fg group-hover:block" />
        </>
      )}
    </span>
  );

  const coverBlock = (
    <span className="relative">
      <Cover trackId={track.id} hasCover={track.hasCover} size={mobile ? 48 : 40} />
      {(!numbered || !desktop) && isCurrent && (
        <span className="absolute inset-0 flex items-center justify-center rounded-xs bg-black/50">
          <Equalizer paused={!isPlaying} />
        </span>
      )}
      {canHover && !isCurrent && !numbered && (
        <span className="absolute inset-0 hidden items-center justify-center rounded-xs bg-black/50 text-white group-hover:flex">
          <Icon name="play" size={18} />
        </span>
      )}
    </span>
  );

  const content = (
    <div
      role="listitem"
      aria-current={isCurrent || undefined}
      tabIndex={0}
      onClick={
        canHover && !selecting
          ? (e) => {
              if (selectable && (e.ctrlKey || e.metaKey)) setSelected(new Set([track.id])); // Ctrl/⌘+click starts multi-select
            }
          : onActivate
      }
      onDoubleClick={canHover && !selecting ? onActivate : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate();
      }}
      {...touchHandlers}
      className={`group focus-ring grid h-full cursor-default select-none items-center gap-3 rounded-control px-2 transition-colors duration-fast
        ${isSel ? "bg-accent-soft" : "hover:bg-surface-2"}`}
      style={desktop ? { gridTemplateColumns: cols } : { gridTemplateColumns: `${selecting ? "32px " : ""}auto minmax(0,1fr) auto` }}
    >
      {selecting && !desktop && <SelBox on={isSel} />}
      {lead}
      <div className={desktop ? "flex min-w-0 items-center gap-3" : "contents"}>
        {selecting && desktop && <SelBox on={isSel} />}
        {canHover && !numbered ? (
          <button
            className="focus-ring rounded-xs"
            aria-label={t("tracks.row.playAria", { title: track.title })}
            onClick={(e) => {
              e.stopPropagation();
              selecting ? toggleSel(track.id) : play(index);
            }}
          >
            {coverBlock}
          </button>
        ) : (
          coverBlock
        )}
        <div className="min-w-0">
          <div className={titleCls}>{track.title}</div>
          <div className="truncate text-body-sm text-fg-muted">
            {track.liked && !desktop && <Icon name="heart-filled" size={12} className="mr-1 inline text-accent align-[-1px]" aria-label={t("tracks.row.liked")} />}
            {track.artist ? (
              desktop ? (
                <ArtistLinks artist={track.artist} />
              ) : (
                track.artist
              )
            ) : (
              t("common.unknownArtist")
            )}
            {!desktop && track.durationMs > 0 && <span className="text-fg-subtle"> · {fmtMs(track.durationMs)}</span>}
          </div>
        </div>
      </div>
      {desktop && showAlbum && (
        <div className="truncate text-body-sm text-fg-muted">
          {track.album ? (
            <Link
              to="/album/$artist/$name"
              params={{ artist: track.artist, name: track.album }}
              className="hover:text-fg hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {track.album}
            </Link>
          ) : (
            <span className="text-fg-subtle">—</span>
          )}
        </div>
      )}
      {desktop && showAdded && <div className="text-body-sm text-fg-muted tabular">{fmtDate(track.addedAt)}</div>}
      {desktop && (
        <button
          aria-label={track.liked ? t("tracks.action.unlike") : t("tracks.action.like")}
          aria-pressed={track.liked}
          onClick={(e) => {
            e.stopPropagation();
            like.mutate({ id: track.id, liked: !track.liked });
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={`focus-ring flex size-9 items-center justify-center rounded-full ${track.liked ? "text-accent" : "text-fg-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
        >
          <Icon name={track.liked ? "heart-filled" : "heart"} size={20} />
        </button>
      )}
      {desktop && <div className="text-right text-body-sm text-fg-muted tabular">{fmtMs(track.durationMs)}</div>}
      {!selecting && <TrackMenuButton track={track} ctx={ctx} className={desktop ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" : ""} />}
      {selecting && desktop && <span />}
    </div>
  );

  return (
    <TrackContextMenu track={track} ctx={ctx} disabled={!canHover || selecting}>
      {content}
    </TrackContextMenu>
  );
});

function SelBox({ on }: { on: boolean }) {
  return (
    <span className={`flex size-6 items-center justify-center rounded-xs border-2 ${on ? "border-accent bg-accent text-fg-on-accent" : "border-fg-subtle"}`}>
      {on && <Icon name="check" size={16} />}
    </span>
  );
}

function SelectionBar({
  tracks,
  selected,
  onClose,
  setSelected,
}: {
  tracks: Track[];
  selected: Set<string>;
  onClose: () => void;
  setSelected: (s: Set<string>) => void;
}) {
  const chosen = tracks.filter((t) => selected.has(t.id));
  const p = usePlayer.getState;
  const btn = "focus-ring state-layer flex h-11 items-center gap-2 rounded-control px-3 text-label disabled:opacity-40";
  return (
    <div className="fixed inset-x-2 z-[45] mx-auto flex max-w-3xl flex-wrap items-center gap-1 rounded-card bg-surface-3 p-2 shadow-float bottom-[calc(var(--spacing-tabbar)+var(--spacing-miniplayer)+12px+env(safe-area-inset-bottom))] md:bottom-[calc(var(--spacing-playerbar)+12px)]">
      <button className={btn} onClick={onClose} aria-label={t("tracks.selection.cancel")}>
        <Icon name="close" size={20} />
      </button>
      <span className="mr-auto px-1 text-label">{t("tracks.selection.count", { count: chosen.length })}</span>
      <button className={btn} onClick={() => setSelected(new Set(tracks.map((tr) => tr.id)))}>
        {t("tracks.selection.selectAll")}
      </button>
      <button
        className={btn}
        disabled={!chosen.length}
        onClick={() => {
          p().addToQueue(chosen);
          toast(tn("tracks.selection.addedToQueue", chosen.length));
          onClose();
        }}
      >
        <Icon name="queue" size={20} />
        <span className="hidden md:inline">{t("tracks.selection.queue")}</span>
      </button>
      <button className={btn} disabled={!chosen.length} onClick={() => openDialog({ kind: "addToPlaylist", trackIds: chosen.map((tr) => tr.id) })}>
        <Icon name="playlist-add" size={20} />
        <span className="hidden md:inline">{t("tracks.selection.playlist")}</span>
      </button>
      <button className={`${btn} text-danger`} disabled={!chosen.length} onClick={() => openDialog({ kind: "deleteTracks", tracks: chosen })}>
        <Icon name="trash" size={20} />
      </button>
    </div>
  );
}

/** Button to enter multi-select on desktop (mobile uses long-press). */
export function useSelectionHint() {
  return useIsMobile() ? t("tracks.hint.mobile") : t("tracks.hint.desktop");
}
