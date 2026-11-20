import { usePlayback, usePlayer } from "@/player/store";
import { engine } from "@/player/engine";
import { useIsDesktop } from "@/lib/useMedia";
import { Cover } from "../ui/Cover";
import { IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { LikeCurrent, SeekBar, Transport, VolumeControl } from "./controls";
import { t } from "@/i18n";
import { ArtistLinks } from "@/components/ArtistLinks";
import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { SleepItems, useSleepState } from "@/components/SleepButton";
import { SoundDialog } from "@/components/SoundDialog";
import { MenuItems } from "@/components/TrackMenu";
import { useFx } from "@/player/fx";
import { COVER_VT, withCoverTransition } from "@/lib/viewTransition";

/** Fixed bottom player for tablet and desktop. */
export function PlayerBar() {
  const current = usePlayer((s) => s.current);
  const panel = usePlayer((s) => s.panel);
  const lyricsFull = usePlayer((s) => s.lyricsFull);
  const desktop = useIsDesktop();
  const s = usePlayer.getState;
  const openPanel = (p: "nowplaying" | "queue" | "lyrics") => (desktop ? s().togglePanel(p) : s().setNp(true, p === "nowplaying" ? "cover" : p));

  return (
    <div className="hidden h-[var(--spacing-playerbar)] shrink-0 items-center gap-4 bg-canvas px-4 md:flex" role="region" aria-label={t("ui.player.region")}>
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-3">
        {current ? (
          <>
            <button className="focus-ring rounded-xs" onClick={() => openPanel("nowplaying")} aria-label={t("ui.player.openNowPlaying")}>
              <Cover trackId={current.track.id} hasCover={current.track.hasCover} size={56} />
            </button>
            <div className="min-w-0">
              <div className="truncate text-label">{current.track.title}</div>
              <ArtistLinks artist={current.track.artist} className="block truncate text-body-sm text-fg-muted" />
            </div>
            <LikeCurrent size={20} />
          </>
        ) : (
          <span className="text-body-sm text-fg-muted">{t("ui.player.nothingPlaying")}</span>
        )}
      </div>
      <div className="flex w-full max-w-[640px] flex-[2] flex-col">
        <Transport />
        <SeekBar />
      </div>
      <div className="flex flex-1 basis-0 items-center justify-end gap-1">
        {/* Same as the L key: full-screen lyrics on desktop, the Lời tab on tablets. */}
        <IconButton
          icon="lyrics"
          label={t("ui.player.lyrics")}
          shortcut="L"
          active={desktop ? lyricsFull : false}
          onClick={() => (desktop ? s().setLyricsFull(!lyricsFull) : s().setNp(true, "lyrics"))}
          size={20}
        />
        {desktop && <IconButton icon="panel-right" label={t("ui.player.nowPlayingPanel")} active={panel === "nowplaying"} onClick={() => openPanel("nowplaying")} size={20} />}
        {desktop && <VolumeControl />}
        <PlayerMore />
      </div>
    </div>
  );
}

/** ⋯ of the player bar: the song's actions, Âm thanh and Hẹn giờ ngủ. */
function PlayerMore() {
  const current = usePlayer((s) => s.current);
  const fxOn = useFx((s) => s.enabled);
  const sleep = useSleepState();
  const [sound, setSound] = useState(false);
  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label={t("ui.player.more")}
            title={t("ui.player.more")}
            className="focus-ring state-layer relative inline-flex size-10 shrink-0 items-center justify-center rounded-full text-fg-muted hover:text-fg"
          >
            <Icon name="more" size={20} />
            {(fxOn || sleep.active) && <span aria-hidden className="absolute right-2 top-2 size-1.5 rounded-full bg-accent" />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" side="top" sideOffset={8} className="menu-content z-[60] max-h-[70vh] overflow-y-auto">
            {current && (
              <>
                <MenuItems track={current.track} Item={DropdownMenu.Item} Separator={DropdownMenu.Separator} />
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
              </>
            )}
            <DropdownMenu.Item className="menu-item" onSelect={() => setSound(true)}>
              <Icon name="sliders" size={20} className={fxOn ? "text-accent" : "text-fg-muted"} />
              {t("sound.title")}
            </DropdownMenu.Item>
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="menu-item">
                <Icon name="moon" size={20} className={sleep.active ? "text-accent" : "text-fg-muted"} />
                <span className="flex-1">{sleep.label}</span>
                <Icon name="chevron-right" size={18} className="text-fg-muted" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent sideOffset={4} className="menu-content z-[61]">
                  <SleepItems Item={DropdownMenu.Item} />
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {sound && <SoundDialog open onClose={() => setSound(false)} />}
    </>
  );
}

/** Floating mini player above the tab bar on mobile. */
export function MiniPlayer() {
  const current = usePlayer((s) => s.current);
  const npOpen = usePlayer((s) => s.npOpen);
  const playing = usePlayback((s) => s.isPlaying);
  const buffering = usePlayback((s) => s.buffering);
  const position = usePlayback((s) => s.position);
  const duration = usePlayback((s) => s.duration);
  if (!current) return null;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <div className="px-2 pb-1 md:hidden">
      <div
        className="relative flex h-[var(--spacing-miniplayer)] items-center gap-3 overflow-hidden rounded-control bg-surface-2 pl-2 pr-1 shadow-float"
        onClick={() => withCoverTransition(() => usePlayer.getState().setNp(true, "cover"))}
        role="button"
        aria-label={t("ui.player.openNowPlayingTrack", { title: current.track.title })}
      >
        <div style={{ viewTransitionName: npOpen ? undefined : COVER_VT }} className="shrink-0 rounded-xs">
          <Cover trackId={current.track.id} hasCover={current.track.hasCover} size={48} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-label">{current.track.title}</div>
          <div className="truncate text-body-sm text-fg-muted">{current.track.artist}</div>
        </div>
        <IconButton
          icon="skip-forward"
          label={t("ui.player.nextTrack")}
          tooltip={false}
          onClick={(e) => {
            e.stopPropagation();
            engine.next();
          }}
          className="!text-fg"
        />
        <button
          aria-label={playing ? t("common.pause") : t("common.play")}
          className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-full text-fg"
          onClick={(e) => {
            e.stopPropagation();
            engine.toggle();
          }}
        >
          {buffering && playing ? <Icon name="loader" /> : <Icon name={playing ? "pause" : "play"} />}
        </button>
        <div className="absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full bg-surface-4">
          <div className="h-full bg-fg" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
