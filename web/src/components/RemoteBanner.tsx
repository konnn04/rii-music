import { useEffect, useMemo, useState } from "react";
import { remoteCommand, remotePositionMs, takeOver, useRemote } from "@/player/sync";
import { openRemoteSheet, useRemoteSheet } from "@/player/view";
import { fmtTime } from "@/lib/format";
import { t } from "@/i18n";
import { Button, IconButton, PlayButton } from "./ui/Button";
import { Cover } from "./ui/Cover";
import { Dialog } from "./ui/Dialog";
import { Slider } from "./ui/Slider";
import { Icon } from "./ui/Icon";
import type { Track } from "@/lib/api";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "./ui/Toast";

/** Remote control sheet for the device that plays (opened from the player bar / mini player). */
export function RemoteSheet() {
  const s = useRemote((r) => r.session);
  const title = useRemote((r) => r.title);
  const tracks = useRemote((r) => r.tracks);
  const [busy, setBusy] = useState(false);
  const open = useRemoteSheet((r) => r.open) && !!s;
  const setOpen = (v: boolean) => openRemoteSheet(v);
  const [now, setNow] = useState(() => Date.now());
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [volDrag, setVolDrag] = useState<number | null>(null);

  const playing = !!s?.playing;
  useEffect(() => {
    if (!playing) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [playing]);

  useEffect(() => {
    if (!s) {
      openRemoteSheet(false);
      setDragMs(null);
      setVolDrag(null);
    }
  }, [s]);

  const trackById = useMemo(() => new Map(tracks.map((tr) => [tr.id, tr])), [tracks]);

  if (!s) return null;

  const currentTrack = tracks[0];
  const displayTitle = title || currentTrack?.title || "";
  const posMs = remotePositionMs(s, now);
  const displayPosMs = dragMs ?? posMs;
  const durationMs = s.durationMs || 0;
  const volVal = volDrag ?? Math.round((s.volume ?? 1) * 100);

  const queueItems = s.upcoming
    .slice(0, 50)
    .map((id, index) => ({ id, index, track: trackById.get(id) }))
    .filter((item): item is { id: string; index: number; track: NonNullable<typeof item.track> } => !!item.track);

  const take = async () => {
    setBusy(true);
    try {
      await takeOver();
      setOpen(false);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("ui.remote.controlTitle", { device: s.deviceName })}
        footer={
          <Button variant="primary" loading={busy} onClick={take} className="w-full sm:w-auto">
            {t("ui.remote.playHere")}
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col items-center text-center">
            <Cover
              trackId={currentTrack?.id}
              hasCover={!!currentTrack?.hasCover}
              size="min(280px, 65vw)"
              rounded="rounded-card"
              className="shadow-float"
            />
            <div className="mt-4 w-full truncate text-title-3 text-fg">{displayTitle || "—"}</div>
            {currentTrack?.artist && (
              <div className="mt-0.5 w-full truncate text-body-sm text-fg-muted">{currentTrack.artist}</div>
            )}
          </div>

          <div className="flex flex-col">
            <Slider
              label={t("ui.remote.seek")}
              value={displayPosMs}
              max={durationMs}
              step={500}
              valueText={`${fmtTime(displayPosMs / 1000)} / ${fmtTime(durationMs / 1000)}`}
              onChange={setDragMs}
              onCommit={(v) => {
                void remoteCommand({ cmd: "seek", positionMs: Math.round(v) });
                setDragMs(null);
              }}
            />
            <div className="flex justify-between text-caption tabular text-fg-muted">
              <span>{fmtTime(displayPosMs / 1000)}</span>
              <span>-{fmtTime(Math.max(0, (durationMs - displayPosMs) / 1000))}</span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <IconButton
              icon="shuffle"
              label={s.shuffle ? t("ui.player.shuffleOff") : t("common.shuffle")}
              active={s.shuffle}
              size={20}
              onClick={() => void remoteCommand({ cmd: "shuffle" })}
            />
            <IconButton
              icon="skip-back"
              label={t("ui.player.prevTrack")}
              size={26}
              className="!text-fg"
              onClick={() => void remoteCommand({ cmd: "prev" })}
            />
            <PlayButton
              playing={s.playing}
              size={56}
              onClick={() => void remoteCommand({ cmd: "toggle" })}
            />
            <IconButton
              icon="skip-forward"
              label={t("ui.player.nextTrack")}
              size={26}
              className="!text-fg"
              onClick={() => void remoteCommand({ cmd: "next" })}
            />
            <IconButton
              icon={s.repeat === "one" ? "repeat-one" : "repeat"}
              label={
                s.repeat === "off"
                  ? t("ui.player.repeatOff")
                  : s.repeat === "all"
                    ? t("ui.player.repeatAll")
                    : t("ui.player.repeatOne")
              }
              active={s.repeat !== "off"}
              size={20}
              onClick={() => void remoteCommand({ cmd: "repeat" })}
            />
          </div>

          <div className="flex items-center gap-2">
            <IconButton
              icon={volVal === 0 ? "volume-mute" : "volume"}
              label={volVal === 0 ? t("ui.player.unmute") : t("ui.player.mute")}
              size={20}
              className="!size-9"
              onClick={() => void remoteCommand({ cmd: "volume", volume: volVal === 0 ? 1 : 0 })}
            />
            <Slider
              label={t("ui.remote.volume")}
              value={volVal}
              max={100}
              step={1}
              valueText={`${volVal}%`}
              onChange={setVolDrag}
              onCommit={(v) => {
                void remoteCommand({ cmd: "volume", volume: Math.round(v) / 100 });
                setVolDrag(null);
              }}
              className="flex-1"
            />
            <span className="w-9 shrink-0 text-right text-caption tabular text-fg-muted">{volVal}%</span>
          </div>

          <div>
            <div className="mb-2 text-overline uppercase text-fg-subtle">
              {t("ui.remote.queueOn", { device: s.deviceName })}
            </div>
            {queueItems.length > 0 ? (
              <RemoteQueue items={queueItems} />
            ) : (
              <p className="py-3 text-center text-body-sm text-fg-muted">{t("ui.remote.queueEmpty")}</p>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}

type QueueItem = { id: string; index: number; track: Track };

/** The other device's upcoming songs: drag to reorder (same as the local queue), tap to play, ✕ to remove. */
function RemoteQueue({ items }: { items: QueueItem[] }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const key = (it: QueueItem) => `${it.index}:${it.id}`;
  const onEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.find((it) => key(it) === e.active.id);
    const to = items.find((it) => key(it) === e.over!.id);
    if (from && to) void remoteCommand({ cmd: "move", index: from.index, to: to.index, trackId: from.id });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
      <SortableContext items={items.map(key)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-0.5">
          {items.map((it) => (
            <RemoteQueueRow key={key(it)} id={key(it)} item={it} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function RemoteQueueRow({ id, item }: { id: string; item: QueueItem }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const { track, index } = item;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex h-14 items-center gap-2 rounded-control pl-1 pr-1 ${isDragging ? "relative z-10 bg-surface-3 shadow-float" : "state-layer"}`}
    >
      <span
        {...attributes}
        {...listeners}
        className="focus-ring flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xs text-fg-muted"
        aria-label={t("player.queue.drag", { title: track.title })}
      >
        <Icon name="grip" size={20} />
      </span>
      <button
        type="button"
        onClick={() => void remoteCommand({ cmd: "jump", index, trackId: item.id })}
        className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-xs text-left"
      >
        <Cover trackId={track.id} hasCover={track.hasCover} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-label text-fg">{track.title}</div>
          <div className="truncate text-caption text-fg-muted">{track.artist}</div>
        </div>
      </button>
      <IconButton
        icon="close"
        label={t("ui.remote.removeFromQueue")}
        size={18}
        tooltip={false}
        className="!size-10"
        onClick={() => void remoteCommand({ cmd: "remove", index, trackId: item.id })}
      />
    </div>
  );
}
