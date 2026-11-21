import { useState } from "react";
import { ctl, useRemoteView, useViewModes, useViewPlaying, useViewTime, useViewTrack, useViewVolume } from "@/player/view";
import { fmtTime } from "@/lib/format";
import { useToggleLike } from "@/lib/queries";
import { IconButton, PlayButton } from "../ui/Button";
import { Slider } from "../ui/Slider";
import { t } from "@/i18n";

export function SeekBar({ np, compact }: { np?: boolean; compact?: boolean }) {
  const { position, duration } = useViewTime();
  const [drag, setDrag] = useState<number | null>(null);
  const v = drag ?? position;
  const times = (cls: string, text: string) => <span className={`w-10 shrink-0 text-caption tabular ${np ? "text-np-fg-muted" : "text-fg-muted"} ${cls}`}>{text}</span>;
  const slider = (
    <Slider
      label={t("ui.player.seek")}
      value={v}
      max={duration}
      step={0.5}
      np={np}
      valueText={`${fmtTime(v)} / ${fmtTime(duration)}`}
      onChange={setDrag}
      onCommit={(x) => {
        ctl.seek(x);
        setDrag(null);
      }}
      className="flex-1"
    />
  );
  if (compact) return slider;
  if (np) {
    return (
      <div className="flex flex-col">
        {slider}
        <div className="flex justify-between">
          {times("", fmtTime(v))}
          {times("text-right", `-${fmtTime(Math.max(0, duration - v))}`)}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {times("text-right", fmtTime(v))}
      {slider}
      {times("", fmtTime(duration))}
    </div>
  );
}

export function Transport({ size = "md", np }: { size?: "md" | "lg"; np?: boolean }) {
  const playing = useViewPlaying();
  const { shuffle, repeat } = useViewModes();
  const has = !!useViewTrack();
  const lg = size === "lg";
  const act = np ? "!text-np-accent" : "";
  return (
    <div className={`flex items-center ${lg ? "justify-between" : "justify-center gap-2"}`}>
      <IconButton
        icon="shuffle"
        label={shuffle ? t("ui.player.shuffleOff") : t("common.shuffle")}
        active={shuffle}
        className={shuffle ? act : np ? "!text-np-fg-muted" : ""}
        onClick={ctl.toggleShuffle}
        size={lg ? 24 : 20}
      />
      <IconButton icon="skip-back" label={t("ui.player.prevTrack")} shortcut="Shift+←" onClick={ctl.prev} disabled={!has} size={lg ? 32 : 24} className={np ? "!text-fg" : "!text-fg"} />
      <PlayButton playing={playing} onClick={ctl.toggle} size={lg ? 72 : 44} np={np} label={playing ? t("ui.player.pauseShortcut") : t("ui.player.playShortcut")} />
      <IconButton icon="skip-forward" label={t("ui.player.nextTrack")} shortcut="Shift+→" onClick={ctl.next} disabled={!has} size={lg ? 32 : 24} className="!text-fg" />
      <IconButton
        icon={repeat === "one" ? "repeat-one" : "repeat"}
        label={repeat === "off" ? t("ui.player.repeatOff") : repeat === "all" ? t("ui.player.repeatAll") : t("ui.player.repeatOne")}
        active={repeat !== "off"}
        className={repeat !== "off" ? act : np ? "!text-np-fg-muted" : ""}
        onClick={ctl.cycleRepeat}
        size={lg ? 24 : 20}
      />
    </div>
  );
}

export function VolumeControl() {
  const { volume, muted } = useViewVolume();
  const remote = !!useRemoteView();
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? (muted ? 0 : volume * 100);
  return (
    <div className="flex w-36 items-center gap-1">
      <IconButton icon={muted || volume === 0 ? "volume-mute" : "volume"} label={muted ? t("ui.player.unmute") : t("ui.player.mute")} shortcut="M" onClick={ctl.toggleMute} size={20} />
      <Slider
        label={t("ui.player.volume")}
        value={shown}
        max={100}
        // Local: live. Remote: on release, one command instead of dozens.
        onChange={(v) => (remote ? setDrag(v) : ctl.setVolume(v / 100))}
        onCommit={(v) => {
          if (remote) ctl.setVolume(v / 100);
          setDrag(null);
        }}
        className="flex-1"
        valueText={`${Math.round(shown)}%`}
      />
    </div>
  );
}

export function LikeCurrent({ np, size = 24 }: { np?: boolean; size?: number }) {
  const track = useViewTrack();
  const like = useToggleLike();
  if (!track) return null;
  return (
    <IconButton
      icon={track.liked ? "heart-filled" : "heart"}
      label={track.liked ? t("ui.player.unlike") : t("ui.player.like")}
      active={track.liked}
      className={track.liked && np ? "!text-np-accent" : np ? "!text-np-fg-muted" : ""}
      onClick={() => like.mutate({ id: track.id, liked: !track.liked })}
      size={size}
    />
  );
}
