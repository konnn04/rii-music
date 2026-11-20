import { useEffect, useState } from "react";
import { create } from "zustand";
import { useNavigate } from "@tanstack/react-router";
import { api, type Rule, type Track } from "@/lib/api";
import { invalidateLibrary, useAddToPlaylist, useArtists, useCreatePlaylist, usePlaylists, useToggleLike } from "@/lib/queries";
import { usePlayer } from "@/player/store";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Icon, type IconName } from "./ui/Icon";
import { Collage, Cover } from "./ui/Cover";
import { toast } from "./ui/Toast";
import { t, tn, tsv } from "@/i18n";

export type TrackContext = { playlistId?: string; playlistKind?: string };

type DialogState =
  | { kind: "addToPlaylist"; trackIds: string[] }
  | { kind: "newPlaylist"; trackIds?: string[]; smart?: boolean }
  | { kind: "editTrack"; track: Track }
  | { kind: "deleteTracks"; tracks: Track[] }
  | { kind: "trackSheet"; track: Track; ctx?: TrackContext }
  | null;

export const useDialogs = create<{ d: DialogState }>(() => ({ d: null }));
export const openDialog = (d: DialogState) => useDialogs.setState({ d });
const close = () => useDialogs.setState({ d: null });

export type Action = { key: string; label: string; icon: IconName; run: () => void; danger?: boolean; shortcut?: string };

/** The action set shared by dropdown, context menu and mobile action sheet. */
export function useTrackActions(track: Track, ctx?: TrackContext): { primary: Action[]; danger: Action[] } {
  const navigate = useNavigate();
  const like = useToggleLike();
  const player = usePlayer.getState;
  const primary: Action[] = [
    { key: "next", label: t("tracks.action.playNext"), icon: "queue", run: () => (player().playNext([track]), toast(t("tracks.toast.playNext"))) },
    { key: "queue", label: t("tracks.action.addToQueue"), icon: "plus", run: () => (player().addToQueue([track]), toast(t("tracks.toast.addedToQueue"))) },
    { key: "playlist", label: t("tracks.action.addToPlaylist"), icon: "playlist-add", run: () => openDialog({ kind: "addToPlaylist", trackIds: [track.id] }) },
    {
      key: "like",
      label: track.liked ? t("tracks.action.unlike") : t("tracks.action.like"),
      icon: track.liked ? "heart-filled" : "heart",
      run: () => like.mutate({ id: track.id, liked: !track.liked }),
    },
    {
      key: "radio",
      label: t("tracks.action.radio"),
      icon: "radio",
      run: async () => {
        const r = await api<{ name: string; tracks: Track[] }>(`/api/radio?seed=${track.id}`);
        player().playList(r.tracks, 0, { type: "radio", id: track.id, name: tsv(r.name) }, { shuffle: false });
      },
    },
    {
      key: "similar",
      label: t("tracks.action.similar"),
      icon: "mix",
      run: async () => {
        const r = await api<{ tracks: Track[] }>(`/api/tracks/${track.id}/similar`);
        if (!r.tracks.length) {
          toast(t("tracks.toast.noSimilar"));
          return;
        }
        player().playList([track, ...r.tracks], 0, { type: "radio", id: `similar:${track.id}`, name: t("tracks.action.similarMixName", { title: track.title }) }, { shuffle: false });
      },
    },
  ];
  if (track.artist)
    primary.push({ key: "artist", label: t("tracks.action.goToArtist"), icon: "artist", run: () => navigate({ to: "/artist/$name", params: { name: track.artist } }) });
  if (track.album)
    primary.push({
      key: "album",
      label: t("tracks.action.goToAlbum"),
      icon: "album",
      run: () => navigate({ to: "/album/$artist/$name", params: { artist: track.artist, name: track.album } }),
    });
  primary.push({ key: "edit", label: t("tracks.action.editInfo"), icon: "settings", run: () => openDialog({ kind: "editTrack", track }) });
  const danger: Action[] = [];
  if (ctx?.playlistId && (ctx.playlistKind === "manual" || ctx.playlistId === "liked")) {
    danger.push({
      key: "remove",
      label: ctx.playlistId === "liked" ? t("tracks.action.removeFromLiked") : t("tracks.action.removeFromPlaylist"),
      icon: "close",
      run: async () => {
        await api(`/api/playlists/${ctx.playlistId}/items/${track.id}`, { method: "DELETE" });
        invalidateLibrary();
      },
    });
  }
  danger.push({ key: "delete", label: t("tracks.action.deleteFromLibrary"), icon: "trash", danger: true, run: () => openDialog({ kind: "deleteTracks", tracks: [track] }) });
  return { primary, danger };
}

// ── dialogs ───────────────────────────────────────────────────────────────

export function GlobalDialogs() {
  const d = useDialogs((s) => s.d);
  if (!d) return null;
  switch (d.kind) {
    case "addToPlaylist":
      return <AddToPlaylist trackIds={d.trackIds} />;
    case "newPlaylist":
      return <NewPlaylist trackIds={d.trackIds} smart={d.smart} />;
    case "editTrack":
      return <EditTrack track={d.track} />;
    case "deleteTracks":
      return <DeleteTracks tracks={d.tracks} />;
    case "trackSheet":
      return <TrackSheet track={d.track} ctx={d.ctx} />;
  }
}

function AddToPlaylist({ trackIds }: { trackIds: string[] }) {
  const { data } = usePlaylists();
  const add = useAddToPlaylist();
  const lists = (data ?? []).filter((p) => p.kind === "manual" || p.kind === "system");
  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={t("tracks.action.addToPlaylist")} description={trackIds.length > 1 ? t("tracks.addToPlaylist.selectedCount", { count: trackIds.length }) : undefined}>
      <div className="-mx-2 flex flex-col">
        <button
          className="focus-ring state-layer flex h-14 items-center gap-3 rounded-control px-2 text-left"
          onClick={() => openDialog({ kind: "newPlaylist", trackIds })}
        >
          <span className="flex size-10 items-center justify-center rounded-xs bg-surface-2">
            <Icon name="plus" />
          </span>
          <span className="text-label">{t("tracks.addToPlaylist.newPlaylist")}</span>
        </button>
        {lists.map((p) => (
          <button
            key={p.id}
            className="focus-ring state-layer flex h-14 items-center gap-3 rounded-control px-2 text-left"
            onClick={() => add.mutate({ playlistId: p.id, trackIds }, { onSuccess: close })}
          >
            {p.id === "liked" ? (
              <span className="flex size-10 items-center justify-center rounded-xs bg-accent-soft text-accent">
                <Icon name="heart-filled" size={20} />
              </span>
            ) : (
              <Collage ids={p.coverTrackIds} size={40} rounded="rounded-xs" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label">{tsv(p.name)}</span>
              <span className="block text-caption text-fg-muted">{tn("common.songs", p.trackCount)}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

const ruleLabels: Record<Rule["type"], string> = {
  top30: t("tracks.smartRule.top30"),
  recent: t("tracks.smartRule.recent"),
  unplayed: t("tracks.smartRule.unplayed"),
  artist: t("tracks.smartRule.artist"),
};

function NewPlaylist({ trackIds, smart: smartInit }: { trackIds?: string[]; smart?: boolean }) {
  const [name, setName] = useState("");
  const [smart, setSmart] = useState(!!smartInit);
  const [ruleType, setRuleType] = useState<Rule["type"]>("top30");
  const [artist, setArtist] = useState("");
  const [limit, setLimit] = useState(50);
  const create = useCreatePlaylist();
  const artists = useArtists();
  const navigate = useNavigate();

  useEffect(() => {
    if (smart && !name) setName(ruleLabels[ruleType]);
  }, [smart]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const rule = smart ? { type: ruleType, value: ruleType === "artist" ? artist : undefined, limit } : undefined;
    create.mutate(
      { name: name.trim(), rule, trackIds: smart ? undefined : trackIds },
      {
        onSuccess: (p) => {
          close();
          toast(t("tracks.newPlaylist.created", { name: p.name }), "success");
          if (!trackIds?.length) navigate({ to: "/playlist/$id", params: { id: p.id } });
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={smart ? t("tracks.newPlaylist.titleSmart") : t("tracks.newPlaylist.title")}
      description={trackIds?.length ? tn("tracks.newPlaylist.willAdd", trackIds.length) : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="new-pl" loading={create.isPending} disabled={!name.trim() || (smart && ruleType === "artist" && !artist)}>
            {t("common.create")}
          </Button>
        </>
      }
    >
      <form id="new-pl" onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("tracks.newPlaylist.nameLabel")}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className="input" placeholder={t("tracks.newPlaylist.namePlaceholder")} />
        </Field>
        {!trackIds?.length && (
          <label className="flex items-center gap-3 text-body-sm">
            <input type="checkbox" checked={smart} onChange={(e) => setSmart(e.target.checked)} className="size-5 accent-[var(--vg-accent)]" />
            {t("tracks.newPlaylist.smartToggle")}
          </label>
        )}
        {smart && (
          <>
            <Field label={t("tracks.newPlaylist.ruleLabel")}>
              <select value={ruleType} onChange={(e) => setRuleType(e.target.value as Rule["type"])} className="input">
                {Object.entries(ruleLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            {ruleType === "artist" && (
              <Field label={t("tracks.newPlaylist.artistLabel")}>
                <select value={artist} onChange={(e) => setArtist(e.target.value)} className="input">
                  <option value="">{t("tracks.newPlaylist.chooseArtist")}</option>
                  {artists.data?.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t("tracks.newPlaylist.maxSongs", { count: limit })}>
              <input type="range" min={10} max={200} step={10} value={limit} onChange={(e) => setLimit(+e.target.value)} className="accent-[var(--vg-accent)]" />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-caption text-fg-subtle">{hint}</span>}
    </label>
  );
}

function EditTrack({ track }: { track: Track }) {
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [album, setAlbum] = useState(track.album);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await api<Track>(`/api/tracks/${track.id}`, { method: "PATCH", json: { title, artist, album } });
      usePlayer.getState().patchTrack(track.id, { title: updated.title, artist: updated.artist, album: updated.album });
      invalidateLibrary();
      close();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={t("tracks.edit.title")}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form="edit-track" loading={busy} disabled={!title.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id="edit-track" onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Cover trackId={track.id} hasCover={track.hasCover} size={56} />
          {track.sourceUrl && (
            <a href={track.sourceUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1 text-body-sm text-accent hover:underline">
              <Icon name="link" size={16} /> {t("tracks.edit.youtubeSource")}
            </a>
          )}
        </div>
        <Field label={t("tracks.edit.trackTitle")}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} className="input" autoFocus />
        </Field>
        <Field label={t("tracks.edit.artist")} hint={t("tracks.edit.artistHint")}>
          <input value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={300} className="input" />
        </Field>
        <Field label={t("tracks.edit.album")} hint={t("tracks.edit.albumHint")}>
          <input value={album} onChange={(e) => setAlbum(e.target.value)} maxLength={300} className="input" />
        </Field>
      </form>
    </Dialog>
  );
}

function DeleteTracks({ tracks }: { tracks: Track[] }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      for (const tr of tracks) {
        await api(`/api/tracks/${tr.id}`, { method: "DELETE" });
        usePlayer.getState().removeTrackEverywhere(tr.id);
      }
      invalidateLibrary();
      toast(tracks.length > 1 ? t("tracks.delete.toastMultiple", { count: tracks.length }) : t("tracks.delete.toastSingle"));
      close();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={tracks.length > 1 ? t("tracks.delete.titleMultiple", { count: tracks.length }) : t("tracks.delete.titleSingle", { title: tracks[0].title })}
      description={t("tracks.delete.description")}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" icon="trash" onClick={run} loading={busy}>
            {t("common.delete")}
          </Button>
        </>
      }
    />
  );
}

/** Mobile action sheet for a track. */
function TrackSheet({ track, ctx }: { track: Track; ctx?: TrackContext }) {
  const { primary, danger } = useTrackActions(track, ctx);
  const run = (a: Action) => {
    if (!["playlist", "edit", "delete"].includes(a.key)) close();
    a.run();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={track.title} description={track.artist || undefined}>
      <div className="-mx-4 -mt-2 flex flex-col">
        {[...primary, ...danger].map((a) => (
          <button
            key={a.key}
            onClick={() => run(a)}
            className={`focus-ring state-layer flex h-14 items-center gap-4 rounded-control px-4 text-left text-body ${a.danger ? "text-danger" : ""}`}
          >
            <Icon name={a.icon} className={a.danger ? "" : "text-fg-muted"} />
            {a.label}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
