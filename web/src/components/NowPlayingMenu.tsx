import { useState } from "react";
import type { Track } from "@/lib/api";
import { useFx } from "@/player/fx";
import { SLEEP_CHOICES, setSleep } from "@/player/sleep";
import { t, tn } from "@/i18n";
import { IconButton } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Icon } from "./ui/Icon";
import { notify } from "./ui/Toast";
import { useTrackActions, type Action } from "./dialogs";
import { useSleepState } from "./SleepButton";
import { SoundDialog } from "./SoundDialog";
import { openKaraoke, useKaraoke } from "@/karaoke/store";

/** Single ⋯ button for the mobile Now Playing header: track actions, karaoke, sound settings and sleep timer. */
export function NowPlayingMenuButton({ track }: { track: Track }) {
  const [open, setOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const fxOn = useFx((s) => s.enabled);
  const karaokeOn = useKaraoke((s) => s.mode !== "off");
  const sleep = useSleepState();

  return (
    <>
      <span className="relative inline-flex">
        <IconButton
          icon="more-vertical"
          label={t("player.np.more")}
          size={22}
          tooltip={false}
          className="!text-fg"
          onClick={() => setOpen(true)}
        />
        {(fxOn || karaokeOn || sleep.active) && (
          <span aria-hidden className="pointer-events-none absolute right-2 top-2 size-2 rounded-full bg-np-accent" />
        )}
      </span>
      {open && (
        <NowPlayingSheet
          track={track}
          fxOn={fxOn}
          karaokeOn={karaokeOn}
          onClose={() => setOpen(false)}
          onOpenSound={() => setSoundOpen(true)}
        />
      )}
      {soundOpen && <SoundDialog open onClose={() => setSoundOpen(false)} />}
    </>
  );
}

function NowPlayingSheet({
  track,
  fxOn,
  karaokeOn,
  onClose,
  onOpenSound,
}: {
  track: Track;
  fxOn: boolean;
  karaokeOn: boolean;
  onClose: () => void;
  onOpenSound: () => void;
}) {
  const { primary, danger } = useTrackActions(track);
  const sleep = useSleepState();
  const [sleepOpen, setSleepOpen] = useState(false);

  const run = (a: Action) => {
    if (!["playlist", "edit", "delete"].includes(a.key)) onClose();
    a.run();
  };

  const pickSleep = (c: number | "track" | null) => {
    setSleep(c);
    notify({
      icon: "moon",
      text: c === null ? t("player.sleep.off") : c === "track" ? t("player.sleep.endOfTrackOn") : tn("player.sleep.set", c),
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={track.title} description={track.artist || undefined}>
      <div className="-mx-4 -mt-2 flex flex-col">
        {[...primary, ...danger].map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => run(a)}
            className={`focus-ring state-layer flex h-14 items-center gap-4 rounded-control px-4 text-left text-body ${a.danger ? "text-danger" : ""}`}
          >
            <Icon name={a.icon} className={a.danger ? "" : "text-fg-muted"} />
            {a.label}
          </button>
        ))}

        <div className="my-1 h-px bg-line" role="separator" />

        <button
          type="button"
          onClick={() => {
            onClose();
            openKaraoke(true);
          }}
          className="focus-ring state-layer flex h-14 items-center gap-4 rounded-control px-4 text-left text-body"
        >
          <Icon name="mic" className={karaokeOn ? "text-accent" : "text-fg-muted"} />
          {t("karaoke.title")}
        </button>

        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenSound();
          }}
          className="focus-ring state-layer flex h-14 items-center gap-4 rounded-control px-4 text-left text-body"
        >
          <Icon name="sliders" className={fxOn ? "text-accent" : "text-fg-muted"} />
          {t("sound.title")}
        </button>

        <button
          type="button"
          aria-expanded={sleepOpen}
          onClick={() => setSleepOpen((v) => !v)}
          className="focus-ring state-layer flex h-14 items-center gap-4 rounded-control px-4 text-left text-body"
        >
          <Icon name="moon" className={sleep.active ? "text-accent" : "text-fg-muted"} />
          <span className="min-w-0 flex-1 truncate">{sleep.label}</span>
          <Icon name="chevron-down" size={20} className={`text-fg-muted transition-transform duration-fast ${sleepOpen ? "rotate-180" : ""}`} />
        </button>

        {sleepOpen && (
          <div className="flex flex-col pb-1 pl-10">
            {SLEEP_CHOICES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => pickSleep(m)}
                className="focus-ring state-layer flex h-12 items-center gap-4 rounded-control px-4 text-left text-body"
              >
                {tn("player.sleep.minutes", m)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => pickSleep("track")}
              className="focus-ring state-layer flex h-12 items-center gap-4 rounded-control px-4 text-left text-body"
            >
              <span className="flex-1">{t("player.sleep.endOfTrack")}</span>
              {sleep.endOfTrack && <Icon name="check" size={18} className="text-accent" />}
            </button>
            {sleep.active && (
              <button
                type="button"
                onClick={() => pickSleep(null)}
                className="focus-ring state-layer flex h-12 items-center gap-4 rounded-control px-4 text-left text-body text-danger"
              >
                {t("player.sleep.cancel")}
              </button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
