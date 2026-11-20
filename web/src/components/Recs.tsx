import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { DiscoverTrack, RecTrack } from "@/lib/api";
import { sendFeedback, startDownload, useJobs } from "@/lib/queries";
import { fmtTime } from "@/lib/format";
import { engine } from "@/player/engine";
import { usePlayback, usePlayer, type Source } from "@/player/store";
import { Cover } from "./ui/Cover";
import { Icon } from "./ui/Icon";
import { Button } from "./ui/Button";
import { toast } from "./ui/Toast";
import { t, tsv } from "@/i18n";

/** Track card with the reason it was recommended and "Ít gợi ý kiểu này". */
export function RecCard({ rec, list, index, source }: { rec: RecTrack; list: RecTrack[]; index: number; source: Source }) {
  const isCur = usePlayer((s) => s.current?.track.id === rec.id);
  const playing = usePlayback((s) => s.isPlaying) && isCur;
  const play = () => (isCur ? engine.toggle() : usePlayer.getState().playList(list, index, source, { shuffle: false }));
  return (
    <div className="group relative flex w-[150px] shrink-0 snap-start flex-col gap-2 md:-m-2 md:w-auto md:rounded-card md:p-2 md:hover:bg-surface-1">
      <button className="focus-ring relative rounded-card text-left" onClick={play} aria-label={t("discover.rec.play", { title: rec.title })}>
        <Cover trackId={rec.id} hasCover={rec.hasCover} size="100%" rounded="rounded-card" className="aspect-square !h-auto" />
        <span
          className={`absolute bottom-2 right-2 flex size-11 items-center justify-center rounded-full bg-accent text-fg-on-accent shadow-float transition-opacity duration-base ${
            playing ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:hidden"
          }`}
          aria-hidden
        >
          <Icon name={playing ? "pause" : "play"} size={20} />
        </span>
      </button>
      <DismissButton
        label={t("discover.rec.lessLike", { title: rec.title })}
        onClick={() => sendFeedback("track", rec.id, -1).then(() => toast(t("discover.rec.lessToast")))}
      />
      <div className="min-w-0">
        <div className={`truncate text-label ${isCur ? "text-accent" : ""}`}>{rec.title}</div>
        <div className="truncate text-body-sm text-fg-muted">{rec.artist}</div>
        <div className="mt-0.5 line-clamp-2 text-caption text-fg-subtle">{tsv(rec.reason)}</div>
      </div>
    </div>
  );
}

function DismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      title={t("discover.rec.lessTitle")}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="focus-ring absolute right-1 top-1 flex size-9 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 md:right-3 md:top-3 [@media(hover:none)]:opacity-100"
    >
      <Icon name="close" size={18} />
    </button>
  );
}

/** Artist from an external source; links into the library when we have them. */
export function ExtArtistCard({ name, image, inLibrary, libraryName, reason }: { name: string; image: string; inLibrary?: boolean; libraryName?: string; reason?: string }) {
  const navigate = useNavigate();
  const go = () =>
    inLibrary || libraryName
      ? navigate({ to: "/artist/$name", params: { name: libraryName || name } })
      : navigate({ to: "/search", search: { q: name, scope: "web" } });
  return (
    <button
      onClick={go}
      className="focus-ring group flex w-[140px] shrink-0 snap-start flex-col gap-2 rounded-card text-center md:-m-2 md:w-auto md:p-2 md:hover:bg-surface-1"
      aria-label={inLibrary || libraryName ? t("discover.extArtist.ariaInLibrary", { name }) : t("discover.extArtist.ariaSearch", { name })}
    >
      <span className="relative block aspect-square w-full overflow-hidden rounded-full bg-surface-3">
        {image ? (
          <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-fg-subtle">
            <Icon name="artist" size={40} />
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-label">{name}</span>
        <span className="block truncate text-caption text-fg-muted">{inLibrary || libraryName ? t("discover.extArtist.inLibrary") : reason ? tsv(reason) : t("discover.extArtist.notInLibrary")}</span>
      </span>
    </button>
  );
}

/** A track outside the library, with "Tải về" and "Ít gợi ý kiểu này". */
export function DiscoverRow({ t: track, onDismiss }: { t: DiscoverTrack; onDismiss: () => void }) {
  const jobs = useJobs();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const job = jobs.data?.jobs.find((j) => j.title === `Tìm: ${track.query}` || j.url === `ytsearch1:${track.query}`);
  const active = job && ["queued", "downloading", "processing"].includes(job.status);
  const done = job && (job.status === "done" || job.status === "skipped");
  return (
    <li className="group flex min-h-16 items-center gap-3 rounded-control px-2 py-2 hover:bg-surface-1">
      {track.image ? (
        <img src={track.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-12 shrink-0 rounded-xs bg-surface-3 object-cover" />
      ) : (
        <Cover size={48} hasCover={false} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-body">{track.title}</div>
        <div className="truncate text-body-sm text-fg-muted">
          {track.artist}
          {track.durationSec > 0 && ` · ${fmtTime(track.durationSec)}`}
        </div>
        <div className="truncate text-caption text-fg-subtle">{tsv(track.reason)}</div>
      </div>
      {done ? (
        <span className="flex items-center gap-1 px-2 text-label text-success">
          <Icon name="check" size={18} /> <span className="hidden md:inline">{t("common.downloaded")}</span>
        </span>
      ) : active || sent ? (
        <span className="flex items-center gap-2 px-2 text-label text-fg-muted" aria-live="polite">
          <Icon name="loader" size={18} />
          <span className="hidden md:inline">{job?.stage ? tsv(job.stage) : t("discover.row.queued")}</span>
        </span>
      ) : (
        <Button
          size="sm"
          variant={job?.status === "error" ? "danger" : "primary"}
          icon={job?.status === "error" ? "retry" : "download"}
          loading={busy}
          aria-label={t("discover.row.downloadAria", { title: track.title, artist: track.artist })}
          onClick={async () => {
            setBusy(true);
            try {
              await startDownload(track.query);
              setSent(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="hidden md:inline">{t("common.download")}</span>
        </Button>
      )}
      <button
        aria-label={t("discover.row.lessArtistAria", { artist: track.artist })}
        title={t("discover.rec.lessTitle")}
        onClick={onDismiss}
        className="focus-ring flex size-10 shrink-0 items-center justify-center rounded-full text-fg-muted hover:text-fg"
      >
        <Icon name="close" size={20} />
      </button>
    </li>
  );
}

export function DiscoverLink() {
  return (
    <Link to="/discover" className="focus-ring rounded-xs text-label text-fg-muted hover:text-fg hover:underline">
      {t("discover.link")}
    </Link>
  );
}
