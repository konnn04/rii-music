import { create } from "zustand";
import { api, type Job, type Track, type WebResult } from "./api";
import { queryClient } from "./queries";
import { usePlayer } from "@/player/store";
import { notify } from "@/components/ui/Toast";
import { t } from "@/i18n";

// "Play" on a search result: play at once when the song is already in the
// library or on the server; otherwise download it and start playing the
// moment the download finishes.

/** video id → job id for songs waiting to play. */
export const usePendingPlay = create<{ byVideo: Record<string, string> }>(() => ({ byVideo: {} }));
/** video id → job id for songs waiting to be queued (or played next). */
export const usePendingQueue = create<{ byVideo: Record<string, string>; mode: Record<string, "queue" | "next"> }>(() => ({
  byVideo: {},
  mode: {},
}));

export async function playTrackId(id: string) {
  const tr = await api<Track>(`/api/tracks/${id}`);
  usePlayer.getState().playList([tr], 0, { type: "search", name: tr.title });
}

export async function queueTrackId(id: string) {
  const tr = await api<Track>(`/api/tracks/${id}`);
  usePlayer.getState().addToQueue([tr]);
  notify({ text: t("tracks.toast.addedToQueue"), icon: "queue" });
}

export async function playNextTrackId(id: string) {
  const tr = await api<Track>(`/api/tracks/${id}`);
  usePlayer.getState().playNext([tr]);
  notify({ text: t("tracks.toast.playNext"), icon: "queue" });
}

export async function playWeb(r: WebResult) {
  if (r.inLibrary) return playTrackId(r.inLibrary);
  const res = await api<{ jobs: Job[] }>("/api/downloads", { method: "POST", json: { input: r.url } });
  queryClient.invalidateQueries({ queryKey: ["jobs"] });
  const j = res.jobs[0];
  if (!j) return;
  if ((j.status === "done" || j.status === "skipped") && j.trackId) return playTrackId(j.trackId);
  usePendingPlay.setState((s) => ({ byVideo: { ...s.byVideo, [r.id]: j.id } }));
  if (!r.onServer) notify({ text: t("search.row.willPlay", { title: r.title }), icon: "download" });
}

export async function queueWeb(r: WebResult) {
  if (r.inLibrary) return queueTrackId(r.inLibrary);
  const res = await api<{ jobs: Job[] }>("/api/downloads", { method: "POST", json: { input: r.url } });
  queryClient.invalidateQueries({ queryKey: ["jobs"] });
  const j = res.jobs[0];
  if (!j) return;
  if ((j.status === "done" || j.status === "skipped") && j.trackId) return queueTrackId(j.trackId);
  usePendingQueue.setState((s) => ({ byVideo: { ...s.byVideo, [r.id]: j.id }, mode: { ...s.mode, [r.id]: "queue" } }));
  if (!r.onServer) notify({ text: t("search.row.willQueue"), icon: "queue" });
}

export async function playNextWeb(r: WebResult) {
  if (r.inLibrary) return playNextTrackId(r.inLibrary);
  const res = await api<{ jobs: Job[] }>("/api/downloads", { method: "POST", json: { input: r.url } });
  queryClient.invalidateQueries({ queryKey: ["jobs"] });
  const j = res.jobs[0];
  if (!j) return;
  if ((j.status === "done" || j.status === "skipped") && j.trackId) return playNextTrackId(j.trackId);
  usePendingQueue.setState((s) => ({ byVideo: { ...s.byVideo, [r.id]: j.id }, mode: { ...s.mode, [r.id]: "next" } }));
  if (!r.onServer) notify({ text: t("search.row.willPlayNext"), icon: "queue" });
}

/** Fed from the SSE "job" event: play or queue a pending song when its download lands. */
export function onJobForPlay(job: Job) {
  if (job.status !== "done" && job.status !== "skipped" && job.status !== "error") return;

  const pendingPlay = usePendingPlay.getState().byVideo;
  const playVid = Object.keys(pendingPlay).find((v) => pendingPlay[v] === job.id);
  if (playVid) {
    usePendingPlay.setState((s) => {
      const byVideo = { ...s.byVideo };
      delete byVideo[playVid];
      return { byVideo };
    });
    if (job.trackId && job.status !== "error") void playTrackId(job.trackId);
  }

  const pendingQueue = usePendingQueue.getState();
  const queueVid = Object.keys(pendingQueue.byVideo).find((v) => pendingQueue.byVideo[v] === job.id);
  if (queueVid) {
    const mode = pendingQueue.mode[queueVid] ?? "queue";
    usePendingQueue.setState((s) => {
      const byVideo = { ...s.byVideo };
      const modes = { ...s.mode };
      delete byVideo[queueVid];
      delete modes[queueVid];
      return { byVideo, mode: modes };
    });
    if (job.trackId && job.status !== "error") {
      if (mode === "next") void playNextTrackId(job.trackId);
      else void queueTrackId(job.trackId);
    }
  }
}
