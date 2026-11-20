import { useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { usePlayback, usePlayer, type QueueEntry } from "@/player/store";
import { fmtMs } from "@/lib/format";
import { useCreatePlaylist } from "@/lib/queries";
import { t, tsv } from "@/i18n";
import { Cover } from "../ui/Cover";
import { Icon } from "../ui/Icon";
import { Equalizer } from "../ui/misc";
import { toast } from "../ui/Toast";
import { Hint } from "../ui/Tips";
import { AutoplayButton } from "./AutoplayButton";

const LIMIT = 150;

/** Queue: now playing, manual queue ("thêm tay"), the rest of the source, then autoplay suggestions. Drag to reorder. */
export function QueueView({ compact }: { compact?: boolean }) {
  const current = usePlayer((s) => s.current);
  const manual = usePlayer((s) => s.manual);
  const context = usePlayer((s) => s.context);
  const pos = usePlayer((s) => s.pos);
  const source = usePlayer((s) => s.source);
  const mode = usePlayer((s) => s.autoplayMode);
  const isPlaying = usePlayback((s) => s.isPlaying);
  const [showAll, setShowAll] = useState(false);
  const create = useCreatePlaylist();
  const rest = context.slice(pos + 1);
  const restSource = rest.filter((e) => !e.auto);
  const restAuto = rest.filter((e) => e.auto);
  const shown = showAll ? restSource : restSource.slice(0, LIMIT);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) usePlayer.getState().moveUpcoming(String(e.active.id), String(e.over.id));
  };

  const saveAsPlaylist = () => {
    const tracks = [current, ...manual, ...rest].filter(Boolean).map((e) => e!.track.id);
    const name = t("player.queue.savedName", { date: new Date().toLocaleDateString() });
    create.mutate({ name, trackIds: [...new Set(tracks)] }, { onSuccess: (p) => toast(t("player.queue.savedAs", { name: p.name }), "success") });
  };

  if (!current) return <div className="flex h-full items-center justify-center p-6 text-center text-body text-np-fg-muted">{t("player.queue.empty")}</div>;

  return (
    <div className={`h-full overflow-y-auto px-2 ${compact ? "pb-2" : "pb-6"}`}>
      {!compact && (
        <Group title={t("player.queue.nowPlaying")} action={<AutoplayButton np />}>
          <div className="flex items-center gap-3 rounded-control px-2 py-2">
            <Cover trackId={current.track.id} hasCover={current.track.hasCover} size={48} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium text-np-accent">{current.track.title}</div>
              <div className="truncate text-body-sm text-np-fg-muted">{current.track.artist}</div>
            </div>
            <Equalizer paused={!isPlaying} />
          </div>
        </Group>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
        {manual.length > 0 && (
          <Group title={t("player.queue.manual")} action={<ClearBtn onClick={() => usePlayer.getState().clearManual()} />}>
            <SortableContext items={manual.map((e) => e.uid)} strategy={verticalListSortingStrategy}>
              {manual.map((e) => (
                <QueueRow key={e.uid} e={e} />
              ))}
            </SortableContext>
          </Group>
        )}
        {restSource.length > 0 && (
          <Group
            title={t("player.queue.nextFrom", { source: source?.name ? tsv(source.name) : t("player.queue.list") })}
            action={<ClearBtn onClick={() => usePlayer.getState().clearUpcoming()} />}
          >
            <SortableContext items={shown.map((e) => e.uid)} strategy={verticalListSortingStrategy}>
              {shown.map((e) => (
                <QueueRow key={e.uid} e={e} />
              ))}
            </SortableContext>
            {restSource.length > shown.length && (
              <button className="focus-ring state-layer mt-1 h-10 w-full rounded-control text-label text-np-fg-muted" onClick={() => setShowAll(true)}>
                {t("player.queue.showMore", { n: restSource.length - shown.length })}
              </button>
            )}
          </Group>
        )}
        {restAuto.length > 0 && (
          <Group title={t("player.autoplay.label")} action={compact ? <AutoplayButton np /> : undefined}>
            <SortableContext items={restAuto.map((e) => e.uid)} strategy={verticalListSortingStrategy}>
              {restAuto.map((e) => (
                <QueueRow key={e.uid} e={e} />
              ))}
            </SortableContext>
          </Group>
        )}
      </DndContext>
      {manual.length + rest.length === 0 && (
        <p className="px-2 py-4 text-body-sm text-np-fg-muted">{mode === "off" ? t("player.queue.nothingNext") : t("player.queue.autoplaySoon")}</p>
      )}
      {!compact && (
        <>
          <Hint id="queue-autoplay" className="mx-2 mt-3 !bg-white/10">
            {t("player.autoplay.hint")}
          </Hint>
          <div className="mt-3 px-2">
            <button className="focus-ring state-layer inline-flex h-10 items-center gap-2 rounded-control px-3 text-label text-np-fg-muted" onClick={saveAsPlaylist}>
              <Icon name="playlist-add" size={20} /> {t("player.queue.saveAsPlaylist")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ClearBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="focus-ring state-layer h-9 rounded-control px-3 text-label text-np-fg-muted" onClick={onClick}>
      {t("player.queue.clear")}
    </button>
  );
}

function Group({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-3">
      <div className="flex min-h-10 items-center justify-between gap-2 px-2">
        <h3 className="truncate text-overline uppercase text-np-fg-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function QueueRow({ e }: { e: QueueEntry }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: e.uid });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group flex h-14 items-center gap-2 rounded-control pl-1 pr-1 ${isDragging ? "relative z-10 bg-surface-3 shadow-float" : "hover:bg-white/5"}`}
    >
      <span {...attributes} {...listeners} className="focus-ring flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xs text-np-fg-muted" aria-label={t("player.queue.drag", { title: e.track.title })}>
        <Icon name="grip" size={20} />
      </span>
      <button className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-xs text-left" onClick={() => usePlayer.getState().jumpTo(e.uid)}>
        <Cover trackId={e.track.id} hasCover={e.track.hasCover} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-sm text-fg">{e.track.title}</span>
          <span className="block truncate text-caption text-np-fg-muted">
            {e.track.artist} · {fmtMs(e.track.durationMs)}
          </span>
        </span>
      </button>
      <button
        className="focus-ring flex size-10 shrink-0 items-center justify-center rounded-full text-np-fg-muted hover:text-fg"
        aria-label={t("player.queue.remove", { title: e.track.title })}
        onClick={() => usePlayer.getState().removeUpcoming(e.uid)}
      >
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
