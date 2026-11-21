import { useEffect, useMemo, useState } from "react";
import { dismissRemote, remoteCommand, remotePositionMs, takeOver, useRemote } from "@/player/sync";
import { fmtTime } from "@/lib/format";
import { t } from "@/i18n";
import { Button, IconButton, PlayButton } from "./ui/Button";
import { Cover } from "./ui/Cover";
import { Dialog } from "./ui/Dialog";
import { Slider } from "./ui/Slider";
import { toast } from "./ui/Toast";

/** Remote control card for another device's active session (collapsed bar + expanded dialog). */
export function RemoteBanner({ className = "" }: { className?: string }) {
  const s = useRemote((r) => r.session);
  const title = useRemote((r) => r.title);
  const tracks = useRemote((r) => r.tracks);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
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
      setOpen(false);
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
  const pct = durationMs > 0 ? Math.min(100, Math.max(0, (posMs / durationMs) * 100)) : 0;
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
      <div
        role="status"
        className={`flex flex-col overflow-hidden rounded-control bg-accent-soft text-body-sm ${className}`}
      >
        <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 sm:gap-2 sm:px-3 sm:py-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t("ui.remote.expand", { device: s.deviceName })}
            className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-xs text-left"
          >
            <Cover trackId={currentTrack?.id} hasCover={!!currentTrack?.hasCover} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-label text-fg">{displayTitle || s.deviceName}</div>
              <div className="truncate text-caption text-fg-muted">
                {t(s.playing ? "ui.remote.playingOn" : "ui.remote.pausedOn", { device: s.deviceName })}
              </div>
            </div>
          </button>

          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            <IconButton
              icon={s.playing ? "pause" : "play"}
              label={s.playing ? t("common.pause") : t("common.play")}
              size={18}
              tooltip={false}
              className="!size-8 !text-fg"
              onClick={() => void remoteCommand({ cmd: "toggle" })}
            />
            <IconButton
              icon="skip-forward"
              label={t("ui.player.nextTrack")}
              size={18}
              tooltip={false}
              className="!size-8 !text-fg"
              onClick={() => void remoteCommand({ cmd: "next" })}
            />
            <button
              type="button"
              className="focus-ring h-8 shrink-0 rounded-full bg-accent px-2.5 text-caption font-medium text-fg-on-accent hover:bg-accent-hover disabled:opacity-60 sm:px-3 sm:text-label"
              onClick={take}
              disabled={busy}
            >
              {t("ui.remote.playHere")}
            </button>
            <IconButton
              icon="close"
              label={t("common.close")}
              size={16}
              tooltip={false}
              className="!size-8"
              onClick={dismissRemote}
            />
          </div>
        </div>

        <div className="h-0.5 w-full bg-surface-4/60">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

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
              <div className="flex flex-col gap-0.5">
                {queueItems.map(({ id, index, track }) => (
                  <div
                    key={`${id}-${index}`}
                    className="state-layer flex items-center gap-2 rounded-control px-1.5 py-1"
                  >
                    <button
                      type="button"
                      onClick={() => void remoteCommand({ cmd: "jump", index, trackId: id })}
                      className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-xs text-left"
                    >
                      <Cover trackId={track.id} hasCover={track.hasCover} size={40} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-label text-fg">{track.title}</div>
                        <div className="truncate text-caption text-fg-muted">{track.artist}</div>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center">
                      <IconButton
                        icon="chevron-down"
                        label={t("ui.remote.moveUp")}
                        size={16}
                        tooltip={false}
                        disabled={index === 0}
                        className="!size-8 [&_svg]:rotate-180"
                        onClick={() => void remoteCommand({ cmd: "move", index, to: index - 1, trackId: id })}
                      />
                      <IconButton
                        icon="chevron-down"
                        label={t("ui.remote.moveDown")}
                        size={16}
                        tooltip={false}
                        disabled={index === queueItems.length - 1}
                        className="!size-8"
                        onClick={() => void remoteCommand({ cmd: "move", index, to: index + 1, trackId: id })}
                      />
                      <IconButton
                        icon="close"
                        label={t("ui.remote.removeFromQueue")}
                        size={16}
                        tooltip={false}
                        className="!size-8"
                        onClick={() => void remoteCommand({ cmd: "remove", index, trackId: id })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-3 text-center text-body-sm text-fg-muted">{t("ui.remote.queueEmpty")}</p>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
