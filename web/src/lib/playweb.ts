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

async function playTrackId(id: string) {
  const tr = await api<Track>(`/api/tracks/${id}`);
  usePlayer.getState().playList([tr], 0, { type: "search", name: tr.title });
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

/** Fed from the SSE "job" event: play a pending song when its download lands. */
export function onJobForPlay(job: Job) {
  const pending = usePendingPlay.getState().byVideo;
  const vid = Object.keys(pending).find((v) => pending[v] === job.id);
  if (!vid) return;
  if (job.status === "done" || job.status === "skipped" || job.status === "error") {
    usePendingPlay.setState((s) => {
      const byVideo = { ...s.byVideo };
      delete byVideo[vid];
      return { byVideo };
    });
    if (job.trackId && job.status !== "error") void playTrackId(job.trackId);
  }
}
