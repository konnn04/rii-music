import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Album, Artist, Mix, Playlist, Track } from "@/lib/api";
import { usePlayback, usePlayer, type Source } from "@/player/store";
import { engine } from "@/player/engine";
import { Collage, Cover } from "./ui/Cover";
import { Icon } from "./ui/Icon";
import { t, tn, tsv } from "@/i18n";
import { ArtistLinks } from "@/components/ArtistLinks";

/** Horizontal scroller on mobile, wrapping grid from md up. */
export function Shelf({ children, grid = true }: { children: ReactNode; grid?: boolean }) {
  return (
    <div
      className={`no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-1 md:scroll-px-0 md:px-0 ${
        grid ? "md:grid md:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] md:overflow-visible lg:grid-cols-[repeat(auto-fill,minmax(176px,1fr))]" : ""
      }`}
    >
      {children}
    </div>
  );
}

function CardFrame({ children, to, params, label }: { children: ReactNode; to?: string; params?: Record<string, string>; label: string }) {
  const cls = "group focus-ring flex w-[140px] shrink-0 snap-start flex-col gap-2 rounded-card p-0 md:w-auto md:p-2 md:-m-2 md:hover:bg-surface-1 transition-colors duration-fast";
  if (to) {
    return (
      <Link to={to} params={params as never} className={cls} aria-label={label}>
        {children}
      </Link>
    );
  }
  return <div className={cls}>{children}</div>;
}

function HoverPlay({ onPlay, playing }: { onPlay: () => void; playing?: boolean }) {
  return (
    <button
      aria-label={playing ? t("common.pause") : t("common.play")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPlay();
      }}
      className={`focus-ring absolute bottom-2 right-2 flex size-11 items-center justify-center rounded-full bg-accent text-fg-on-accent shadow-float transition-all duration-base
        ${playing ? "opacity-100" : "translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:hidden"}`}
    >
      <Icon name={playing ? "pause" : "play"} size={20} />
    </button>
  );
}

function useSourcePlaying(src: Source) {
  const same = usePlayer((s) => s.source?.type === src.type && s.source?.id === src.id);
  const playing = usePlayback((s) => s.isPlaying);
  return same && playing;
}

export function TrackCard({ track, tracks, index, source }: { track: Track; tracks: Track[]; index: number; source: Source }) {
  const isCur = usePlayer((s) => s.current?.track.id === track.id);
  const playing = usePlayback((s) => s.isPlaying) && isCur;
  const play = () => (isCur ? engine.toggle() : usePlayer.getState().playList(tracks, index, source, { shuffle: false, oneLang: true }));
  return (
    <div className="group flex w-[140px] shrink-0 snap-start flex-col gap-2 md:-m-2 md:w-auto md:rounded-card md:p-2 md:hover:bg-surface-1">
      <button className="focus-ring relative rounded-card text-left" onClick={play} aria-label={t("ui.card.playAria", { title: track.title })}>
        <Cover trackId={track.id} hasCover={track.hasCover} size="100%" rounded="rounded-card" className="aspect-square !h-auto" />
        <HoverPlay onPlay={play} playing={playing} />
      </button>
      <div className="min-w-0">
        <div className={`truncate text-label ${isCur ? "text-accent" : ""}`}>{track.title}</div>
        <ArtistLinks artist={track.artist} className="block truncate text-body-sm text-fg-muted" />
      </div>
    </div>
  );
}

export function AlbumCard({ album }: { album: Album }) {
  return (
    <CardFrame to="/album/$artist/$name" params={{ artist: album.artist, name: album.name }} label={t("ui.card.albumAria", { name: album.name })}>
      <Cover trackId={album.coverTrackId} hasCover={!!album.coverTrackId} size="100%" rounded="rounded-card" className="aspect-square !h-auto" />
      <div className="min-w-0">
        <div className="truncate text-label">{album.name}</div>
        <div className="truncate text-body-sm text-fg-muted">{album.artist || t("ui.card.variousArtists")}</div>
      </div>
    </CardFrame>
  );
}

export function ArtistCard({ artist }: { artist: Pick<Artist, "name" | "coverTrackId"> & { trackCount?: number } }) {
  return (
    <CardFrame to="/artist/$name" params={{ name: artist.name }} label={t("ui.card.artistAria", { name: artist.name })}>
      <Cover trackId={artist.coverTrackId} hasCover={!!artist.coverTrackId} size="100%" rounded="rounded-full" className="aspect-square !h-auto" />
      <div className="min-w-0 text-center">
        <div className="truncate text-label">{artist.name}</div>
        <div className="truncate text-body-sm text-fg-muted">{artist.trackCount != null ? tn("common.songs", artist.trackCount) : t("ui.card.artistLabel")}</div>
      </div>
    </CardFrame>
  );
}

export function PlaylistCard({ p }: { p: Playlist }) {
  const displayName = tsv(p.name);
  return (
    <CardFrame to="/playlist/$id" params={{ id: p.id }} label={t("ui.card.playlistAria", { name: displayName })}>
      {p.id === "liked" ? (
        <div className="flex aspect-square w-full items-center justify-center rounded-card bg-linear-to-br from-accent-soft to-surface-3 text-accent">
          <Icon name="heart-filled" size={48} />
        </div>
      ) : (
        <Collage ids={p.coverTrackIds} size="100%" className="aspect-square !h-auto" />
      )}
      <div className="min-w-0">
        <div className="truncate text-label">{displayName}</div>
        <div className="truncate text-body-sm text-fg-muted">
          {p.kind === "smart" ? `${t("common.nav.smart")} · ` : ""}
          {tn("common.songs", p.trackCount)}
        </div>
      </div>
    </CardFrame>
  );
}

const mixHues = [232, 160, 20, 300];

export function MixCard({ mix, i }: { mix: Mix; i: number }) {
  const mixName = tsv(mix.name);
  const mixReason = tsv(mix.reason);
  const src: Source = { type: "mix", id: mix.id, name: `${mixName} — ${mixReason}` };
  const playing = useSourcePlaying(src);
  const play = () => (playing ? engine.toggle() : usePlayer.getState().playList(mix.tracks, 0, src, { shuffle: false }));
  const hue = mixHues[i % mixHues.length];
  return (
    <div className="group flex w-[160px] shrink-0 snap-start flex-col gap-2 md:-m-2 md:w-auto md:rounded-card md:p-2 md:hover:bg-surface-1">
      <button className="focus-ring relative rounded-card" onClick={play} aria-label={t("ui.card.playAria", { title: mixName })}>
        <Collage ids={mix.tracks.filter((tr) => tr.hasCover).map((tr) => tr.id)} size="100%" className="aspect-square !h-auto" />
        <span
          className="absolute left-2 top-2 rounded-xs px-2 py-0.5 text-overline uppercase"
          style={{ background: `hsl(${hue} 60% 74%)`, color: "#0E0F12" }}
        >
          {mixName}
        </span>
        <HoverPlay onPlay={play} playing={playing} />
      </button>
      <div className="min-w-0">
        <div className="line-clamp-2 text-body-sm text-fg-muted">{mixReason}</div>
      </div>
    </div>
  );
}
