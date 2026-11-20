import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { api, ApiError, type Track, type WebList, type WebResult } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { CollectionRow, WebRow } from "./Search";
import { invalidateLibrary, queryClient, useAlbum, useArtist, usePlaylist, useSimilarArtists } from "@/lib/queries";
import { fmtTotal } from "@/lib/format";
import { usePlayback, usePlayer, type Source } from "@/player/store";
import { engine } from "@/player/engine";
import { Button, IconButton, PlayButton } from "@/components/ui/Button";
import { Collage, Cover } from "@/components/ui/Cover";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Empty, ErrorState, SectionHeader, Spinner } from "@/components/ui/misc";
import { AlbumCard, ArtistCard, Shelf } from "@/components/Cards";
import { ExtArtistCard } from "@/components/Recs";
import { TrackList } from "@/components/TrackList";
import { Field, openDialog } from "@/components/dialogs";
import { toast } from "@/components/ui/Toast";
import { DropdownMenu } from "radix-ui";
import { t, tn, tsv } from "@/i18n";
import { FollowButton } from "@/components/Follow";

/** Header for playlist / album / artist: big art + title + actions. */
function DetailHeader({ art, kicker, title, meta, actions }: { art: ReactNode; kicker: string; title: string; meta: string; actions: ReactNode }) {
  return (
    <header className="flex flex-col items-center gap-4 px-4 pb-6 pt-[calc(16px+env(safe-area-inset-top))] text-center md:flex-row md:items-end md:gap-6 md:px-6 md:pt-6 md:text-left lg:pt-2">
      <div className="w-[min(60vw,232px)] shrink-0 shadow-sheet md:w-[184px] lg:w-[232px] [&>*]:!w-full [&>*]:!h-auto [&>*]:aspect-square">{art}</div>
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-overline uppercase text-fg-muted">{kicker}</span>
        <h1 className="line-clamp-2 break-words text-title-1 lg:text-display">{title}</h1>
        <p className="text-body-sm text-fg-muted">{meta}</p>
        <div className="mt-2 flex items-center justify-center gap-2 md:justify-start">{actions}</div>
      </div>
    </header>
  );
}

function PlayActions({ tracks, source, extra }: { tracks: Track[]; source: Source; extra?: ReactNode }) {
  const same = usePlayer((s) => s.source?.type === source.type && s.source?.id === source.id);
  const playing = usePlayback((s) => s.isPlaying) && same;
  return (
    <>
      <PlayButton
        playing={playing}
        onClick={() => (same ? engine.toggle() : usePlayer.getState().playList(tracks, 0, source, { shuffle: false }))}
        label={playing ? t("common.pause") : t("detail.playAll")}
      />
      <IconButton icon="shuffle" label={t("detail.shufflePlay")} onClick={() => usePlayer.getState().playList(tracks, -1, source, { shuffle: true })} disabled={!tracks.length} />
      <IconButton
        icon="queue"
        label={t("detail.addAllToQueue")}
        onClick={() => {
          usePlayer.getState().addToQueue(tracks);
          toast(tn("detail.addedToQueue", tracks.length));
        }}
        disabled={!tracks.length}
      />
      {extra}
    </>
  );
}

const durationMeta = (ts: Track[]) => `${tn("common.songs", ts.length)} · ${fmtTotal(ts.reduce((a, tr) => a + tr.durationMs, 0))}`;

// ── playlist ──────────────────────────────────────────────────────────────

export function PlaylistPage() {
  const { id } = useParams({ from: "/playlist/$id" });
  const { data, isLoading, error, refetch } = usePlaylist(id);
  const navigate = useNavigate();
  const [rename, setRename] = useState(false);
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const { playlist: p, tracks } = data;
  const displayName = tsv(p.name);
  const source: Source = { type: "playlist", id: p.id, name: displayName };
  const manual = p.kind === "manual";

  const reorder = async (ids: string[]) => {
    queryClient.setQueryData(["playlist", id], { ...data, tracks: ids.map((x) => tracks.find((tr) => tr.id === x)!) });
    try {
      await api(`/api/playlists/${id}/items`, { method: "PUT", json: { trackIds: ids } });
    } catch (e) {
      toast((e as Error).message, "error");
      refetch();
    }
  };
  const del = async () => {
    if (!confirm(t("detail.playlist.deleteConfirm", { name: displayName }))) return;
    await api(`/api/playlists/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: ["playlists"] });
    navigate({ to: "/library", search: { tab: "playlists" } });
  };

  const menu = (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <IconButton icon="more" label={t("detail.playlist.actions")} tooltip={false} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" align="start" sideOffset={4}>
          {p.kind !== "system" && (
            <DropdownMenu.Item className="menu-item" onSelect={() => setRename(true)}>
              <Icon name="settings" size={20} className="text-fg-muted" /> {t("detail.playlist.rename")}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className="menu-item" onSelect={() => (location.href = `/api/playlists/${id}/export?format=m3u`)}>
            <Icon name="download" size={20} className="text-fg-muted" /> {t("detail.playlist.exportM3u")}
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => (location.href = `/api/playlists/${id}/export?format=json`)}>
            <Icon name="download" size={20} className="text-fg-muted" /> {t("detail.playlist.exportJson")}
          </DropdownMenu.Item>
          {p.kind !== "system" && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item className="menu-item !text-danger" onSelect={del}>
                <Icon name="trash" size={20} /> {t("detail.playlist.delete")}
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  const kicker = p.kind === "system" ? t("detail.playlist.kickerSystem") : p.kind === "smart" ? t("detail.playlist.kickerSmart") : t("detail.playlist.kicker");
  const art =
    p.id === "liked" ? (
      <div className="flex items-center justify-center rounded-card bg-linear-to-br from-accent-soft to-surface-3 text-accent">
        <Icon name="heart-filled" size={72} />
      </div>
    ) : (
      <Collage ids={p.coverTrackIds} size="100%" />
    );

  return (
    <div>
      <DetailHeader art={art} kicker={kicker} title={displayName} meta={durationMeta(tracks)} actions={<PlayActions tracks={tracks} source={source} extra={menu} />} />
      {tracks.length === 0 ? (
        <Empty icon="playlist-add" title={p.id === "liked" ? t("detail.playlist.emptyLikedTitle") : t("detail.playlist.emptyTitle")}>
          {p.kind === "smart" ? t("detail.playlist.emptySmartBody") : t("detail.playlist.emptyBody")}
        </Empty>
      ) : (
        <div className="px-2 md:px-6">
          {manual && tracks.length > 1 && <p className="mb-2 px-2 text-caption text-fg-subtle">{t("detail.playlist.reorderHint")}</p>}
          <TrackList tracks={tracks} source={source} ctx={{ playlistId: p.id, playlistKind: p.kind }} numbered onReorder={manual ? reorder : undefined} />
        </div>
      )}
      {rename && <RenameDialog id={id} name={p.name} onClose={() => setRename(false)} />}
    </div>
  );
}

function RenameDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [v, setV] = useState(name);
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    try {
      await api(`/api/playlists/${id}`, { method: "PATCH", json: { name: v } });
      invalidateLibrary();
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("detail.playlist.renameTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => save()} disabled={!v.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form onSubmit={save}>
        <Field label={t("detail.playlist.nameLabel")}>
          <input className="input" value={v} onChange={(e) => setV(e.target.value)} autoFocus maxLength={200} />
        </Field>
      </form>
    </Dialog>
  );
}

// ── album ─────────────────────────────────────────────────────────────────

export function AlbumPage() {
  const { artist, name } = useParams({ from: "/album/$artist/$name" });
  const { data, isLoading, error, refetch } = useAlbum(artist, name);
  const navigate = useNavigate();
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const cover = data.tracks.find((tr) => tr.hasCover);
  const source: Source = { type: "album", id: `${artist}\u0000${name}`, name };
  return (
    <div>
      <DetailHeader
        art={<Cover trackId={cover?.id} hasCover={!!cover} size="100%" rounded="rounded-card" />}
        kicker={t("detail.album.kicker")}
        title={name}
        meta={`${artist || t("detail.album.variousArtists")} · ${durationMeta(data.tracks)}`}
        actions={
          <PlayActions
            tracks={data.tracks}
            source={source}
            extra={artist && <IconButton icon="artist" label={t("detail.album.goToArtist")} onClick={() => navigate({ to: "/artist/$name", params: { name: artist } })} />}
          />
        }
      />
      <div className="px-2 md:px-6">
        <TrackList tracks={data.tracks} source={source} numbered showAlbum={false} />
      </div>
      <FullAlbum name={name} artist={artist} have={data.tracks.length} />
    </div>
  );
}

/** The rest of the album, from YouTube Music: play / download the songs you don't have, or save the whole album. */
function FullAlbum({ name, artist, have }: { name: string; artist: string; have: number }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["fullAlbum", artist, name],
    queryFn: () => api<{ found: boolean; album?: WebList }>(`/api/album/full?name=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`),
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const [busy, setBusy] = useState(false);
  const al = q.data?.album;
  if (q.isLoading)
    return (
      <p className="flex items-center gap-2 px-4 py-6 text-body-sm text-fg-muted md:px-6">
        <Icon name="loader" size={18} /> {t("detail.fullAlbum.looking")}
      </p>
    );
  if (!al) return null;
  const missing = al.tracks.filter((tr) => !tr.inLibrary);
  if (!missing.length) return null;
  const saveAll = async () => {
    setBusy(true);
    try {
      const res = await api<{ playlist: { id: string; name: string }; queued: number }>("/api/web/list/save", { method: "POST", json: { id: al.id, title: al.title || name } });
      queryClient.invalidateQueries({ queryKey: ["playlists"] });
      queryClient.invalidateQueries({ queryKey: ["fullAlbum", artist, name] });
      toast(t("detail.fullAlbum.saved", { n: res.queued }), "success");
      navigate({ to: "/playlist/$id", params: { id: res.playlist.id } });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-8 px-2 md:px-6">
      <SectionHeader
        title={t("detail.fullAlbum.title", { have, total: al.tracks.length })}
        sub={t("detail.fullAlbum.sub")}
        action={
          al.saved ? undefined : (
            <Button size="sm" icon="playlist-add" loading={busy} onClick={saveAll}>
              {t("detail.fullAlbum.saveAll")}
            </Button>
          )
        }
      />
      <ul className="flex flex-col">
        {al.tracks.map((tr, i) => (tr.inLibrary ? null : <WebRow key={tr.id} r={tr} index={i + 1} />))}
      </ul>
    </section>
  );
}

// ── artist ────────────────────────────────────────────────────────────────

export function ArtistPage() {
  const { name } = useParams({ from: "/artist/$name" });
  const lib = useArtist(name);
  // The artist on YouTube Music: songs and albums, also for artists with
  // nothing in the library yet (e.g. opened from search or a featured credit).
  const web = useQuery({
    queryKey: ["artistWeb", name],
    queryFn: () => api<{ songs: WebResult[]; albums: WebResult[] }>(`/api/artist/web?name=${encodeURIComponent(name)}`),
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const [all, setAll] = useState(false);
  const notInLibrary = lib.error instanceof ApiError && lib.error.status === 404;
  if (lib.isLoading) return <Spinner />;
  if (lib.error && !notInLibrary) return <ErrorState error={lib.error} onRetry={lib.refetch} />;
  const data = lib.data ?? { name, tracks: [] as Track[], albums: [], others: [] };
  const cover = data.tracks.find((tr) => tr.hasCover);
  const webPic = web.data?.songs.find((s) => s.thumbnail)?.thumbnail;
  const source: Source = { type: "artist", id: name, name };
  const shown = all ? data.tracks : data.tracks.slice(0, 10);
  const webSongs = web.data?.songs ?? [];
  const webAlbums = web.data?.albums ?? [];
  return (
    <div className="flex flex-col gap-8">
      <DetailHeader
        art={
          cover || !webPic ? (
            <Cover trackId={cover?.id} hasCover={!!cover} size="100%" rounded="rounded-full" />
          ) : (
            <img src={webPic} alt="" referrerPolicy="no-referrer" className="aspect-square rounded-full bg-surface-3 object-cover" />
          )
        }
        kicker={t("detail.artist.kicker")}
        title={name}
        meta={
          data.tracks.length
            ? `${tn("common.songs", data.tracks.length)} · ${tn("detail.artist.albumsCount", data.albums.length)} · ${tn("detail.artist.playsCount", data.tracks.reduce((a, tr) => a + tr.playCount, 0))}`
            : t("detail.artist.notInLibrary")
        }
        actions={
          data.tracks.length > 0 ? <PlayActions
            tracks={data.tracks}
            source={source}
            extra={
              <>
              <IconButton
                icon="radio"
                label={t("detail.artist.radio")}
                onClick={async () => {
                  const seed = data.tracks[0];
                  const r = await api<{ name: string; tracks: Track[] }>(`/api/radio?seed=${seed.id}`);
                  usePlayer.getState().playList(r.tracks, 0, { type: "radio", id: name, name: t("detail.artist.radioName", { name }) }, { shuffle: false });
                }}
              />
              <FollowButton name={name} image={webPic} />
              </>
            }
          /> : <FollowButton name={name} image={webPic} />
        }
      />
      {data.tracks.length > 0 && (
        <section className="md:px-6">
          <SectionHeader title={t("detail.artist.inLibrary")} />
          <div className="px-2 md:px-0">
            <TrackList tracks={shown} source={source} numbered selectable={false} />
          </div>
          {data.tracks.length > 10 && (
            <button className="focus-ring state-layer mx-4 mt-2 h-10 rounded-control px-3 text-label text-fg-muted md:mx-0" onClick={() => setAll(!all)}>
              {all ? t("detail.artist.collapse") : tn("detail.artist.showAll", data.tracks.length)}
            </button>
          )}
        </section>
      )}
      {web.isLoading && (
        <div className="px-4 md:px-6">
          <Spinner />
        </div>
      )}
      {webSongs.length > 0 && (
        <section className="md:px-6">
          <SectionHeader title={t("detail.artist.webSongs")} />
          <ul className="px-2 md:px-0">
            {webSongs.slice(0, 10).map((r) => (
              <WebRow key={r.id} r={r} />
            ))}
          </ul>
        </section>
      )}
      {data.albums.length > 0 && (
        <section className="md:px-6">
          <SectionHeader title={t("detail.artist.albums")} />
          <Shelf>
            {data.albums.map((a) => (
              <AlbumCard key={a.name} album={a} />
            ))}
          </Shelf>
        </section>
      )}
      {webAlbums.length > 0 && (
        <section className="md:px-6">
          <SectionHeader title={t("detail.artist.webAlbums")} />
          <ul className="px-2 md:px-0">
            {webAlbums.map((r) => (
              <CollectionRow key={r.id} r={r} />
            ))}
          </ul>
        </section>
      )}
      {!web.isLoading && notInLibrary && !webSongs.length && !webAlbums.length && <Empty icon="artist" title={t("detail.artist.nothing")} />}
      <SimilarArtists name={name} />
      {data.others.length > 0 && (
        <section className="md:px-6">
          <SectionHeader title={t("detail.artist.others")} />
          <Shelf>
            {data.others.map((a) => (
              <ArtistCard key={a.name} artist={a} />
            ))}
          </Shelf>
        </section>
      )}
      {data.tracks.length > 0 && (
        <div className="px-4 md:px-6">
          <Button variant="ghost" icon="playlist-add" onClick={() => openDialog({ kind: "addToPlaylist", trackIds: data.tracks.map((tr) => tr.id) })}>
            {t("detail.artist.addAllToPlaylist")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Tier-1 similar artists (Deezer / Last.fm); quietly hidden when unavailable. */
function SimilarArtists({ name }: { name: string }) {
  const { data } = useSimilarArtists(name);
  if (!data?.artists.length) return null;
  return (
    <section className="md:px-6">
      <SectionHeader title={t("detail.artist.similar")} sub={t("detail.artist.similarBy", { provider: data.provider === "lastfm" ? "Last.fm" : "Deezer" })} />
      <Shelf>
        {data.artists.slice(0, 12).map((a) => (
          <ExtArtistCard key={a.name} name={a.name} image={a.image} libraryName={a.libraryName} />
        ))}
      </Shelf>
    </section>
  );
}
