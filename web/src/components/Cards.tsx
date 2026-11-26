import type { HTMLAttributes, ReactNode, Ref, RefAttributes } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { api, type Album, type Artist, type Mix, type Playlist, type Track } from "@/lib/api";
import { usePlayback, usePlayer, type Source } from "@/player/store";
import { engine } from "@/player/engine";
import { Collage, Cover } from "./ui/Cover";
import { Icon } from "./ui/Icon";
import { Tooltip } from "./ui/Tooltip";
import { notify } from "./ui/Toast";
import { t, tn, tsv } from "@/i18n";
import { ArtistLinks } from "@/components/ArtistLinks";
import { TrackContextMenu } from "./TrackMenu";
import { CollectionContextMenu } from "./CollectionMenu";

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

function CardFrame({
  children,
  to,
  params,
  label,
  className,
  ...rest
}: {
  children: ReactNode;
  to?: string;
  params?: Record<string, string>;
  label: string;
} & Omit<HTMLAttributes<HTMLElement>, "children"> & { ref?: Ref<HTMLElement> }) {
  const base = "cv-card group focus-ring flex w-[140px] shrink-0 snap-start flex-col gap-2 rounded-card p-0 md:w-auto md:p-2 md:-m-2 md:hover:bg-surface-1 transition-colors duration-fast";
  const cls = className ? `${base} ${className}` : base;
  if (to) {
    return (
      <Link
        {...(rest as HTMLAttributes<HTMLAnchorElement> & RefAttributes<HTMLAnchorElement>)}
        to={to}
        params={params as never}
        className={cls}
        aria-label={label}
      >
        {children}
      </Link>
    );
  }
  return (
    <div {...(rest as HTMLAttributes<HTMLDivElement> & RefAttributes<HTMLDivElement>)} className={cls}>
      {children}
    </div>
  );
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
    <TrackContextMenu track={track}>
      <div className="group flex w-[140px] shrink-0 snap-start flex-col gap-2 md:-m-2 md:w-auto md:rounded-card md:p-2 md:hover:bg-surface-1">
        <div className="relative">
          <button className="focus-ring block w-full rounded-card text-left" onClick={play} aria-label={t("ui.card.playAria", { title: track.title })}>
            <Cover trackId={track.id} hasCover={track.hasCover} size="100%" rounded="rounded-card" className="aspect-square !h-auto" />
          </button>
          <Tooltip content={t("tracks.action.addToQueue")}>
            <button
              aria-label={t("tracks.action.addToQueue")}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                usePlayer.getState().addToQueue([track]);
                notify({ text: t("tracks.toast.addedToQueue"), icon: "queue" });
              }}
              className="focus-ring absolute bottom-2 left-2 flex size-9 items-center justify-center rounded-full bg-surface-3/90 text-fg shadow-float backdrop-blur-sm transition-all duration-base translate-y-1 opacity-0 hover:bg-surface-3 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:hidden"
            >
              <Icon name="queue" size={18} />
            </button>
          </Tooltip>
          <HoverPlay onPlay={play} playing={playing} />
        </div>
        <div className="min-w-0">
          <div className={`truncate text-label ${isCur ? "text-accent" : ""}`}>{track.title}</div>
          <ArtistLinks artist={track.artist} className="block truncate text-body-sm text-fg-muted" />
        </div>
      </div>
    </TrackContextMenu>
  );
}

export function AlbumCard({ album }: { album: Album }) {
  const navigate = useNavigate();
  const source: Source = { type: "album", id: `${album.artist}\u0000${album.name}`, name: album.name };
  const load = () =>
    api<{ name: string; artist: string; tracks: Track[] }>(
      `/api/album?artist=${encodeURIComponent(album.artist)}&name=${encodeURIComponent(album.name)}`,
    ).then((r) => r.tracks);
  return (
    <CollectionContextMenu
      load={load}
      source={source}
      onOpen={() => navigate({ to: "/album/$artist/$name", params: { artist: album.artist, name: album.name } })}
    >
      <CardFrame to="/album/$artist/$name" params={{ artist: album.artist, name: album.name }} label={t("ui.card.albumAria", { name: album.name })}>
        <Cover trackId={album.coverTrackId} hasCover={!!album.coverTrackId} size="100%" rounded="rounded-card" className="aspect-square !h-auto" />
        <div className="min-w-0">
          <div className="truncate text-label">{album.name}</div>
          <div className="truncate text-body-sm text-fg-muted">{album.artist || t("ui.card.variousArtists")}</div>
        </div>
      </CardFrame>
    </CollectionContextMenu>
  );
}

export function ArtistCard({ artist }: { artist: Pick<Artist, "name" | "coverTrackId"> & { trackCount?: number } }) {
  const navigate = useNavigate();
  const source: Source = { type: "artist", id: artist.name, name: artist.name };
  const load = () => api<{ name: string; tracks: Track[] }>(`/api/artist?name=${encodeURIComponent(artist.name)}`).then((r) => r.tracks);
  return (
    <CollectionContextMenu
      load={load}
      source={source}
      onOpen={() => navigate({ to: "/artist/$name", params: { name: artist.name } })}
    >
      <CardFrame to="/artist/$name" params={{ name: artist.name }} label={t("ui.card.artistAria", { name: artist.name })}>
        <Cover trackId={artist.coverTrackId} hasCover={!!artist.coverTrackId} size="100%" rounded="rounded-full" className="aspect-square !h-auto" />
        <div className="min-w-0 text-center">
          <div className="truncate text-label">{artist.name}</div>
          <div className="truncate text-body-sm text-fg-muted">{artist.trackCount != null ? tn("common.songs", artist.trackCount) : t("ui.card.artistLabel")}</div>
        </div>
      </CardFrame>
    </CollectionContextMenu>
  );
}

export function PlaylistCard({ p }: { p: Playlist }) {
  const navigate = useNavigate();
  const displayName = tsv(p.name);
  const source: Source = { type: "playlist", id: p.id, name: displayName };
  const load = () => api<{ playlist: Playlist; tracks: Track[] }>(`/api/playlists/${encodeURIComponent(p.id)}`).then((r) => r.tracks);
  return (
    <CollectionContextMenu
      load={load}
      source={source}
      onOpen={() => navigate({ to: "/playlist/$id", params: { id: p.id } })}
    >
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
    </CollectionContextMenu>
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
    <CollectionContextMenu load={() => Promise.resolve(mix.tracks)} source={src}>
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
    </CollectionContextMenu>
  );
}
