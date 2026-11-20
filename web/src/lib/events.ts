// Server-sent events: job progress and library changes keep the cache fresh.
import { queryClient, invalidateLibrary } from "./queries";
import type { Job, Settings } from "./api";
import { toast } from "@/components/ui/Toast";
import { usePlayer } from "@/player/store";
import { engine } from "@/player/engine";
import { isAutoplayJob, onJobEvent } from "@/player/autofill";
import { onJobForPlay } from "./playweb";
import { onJobForList } from "@/player/playlistFill";
import { onRemotePlayback, type RemoteSession } from "@/player/sync";
import { t, tsv } from "@/i18n";

let es: EventSource | null = null;
let libTimer: number | null = null;

export function connectEvents() {
  if (es) return;
  es = new EventSource("/api/events", { withCredentials: true });
  es.addEventListener("job", (e) => {
    const job: Job = JSON.parse((e as MessageEvent).data);
    queryClient.setQueryData(["jobs"], (d: { jobs: Job[] } | undefined) => {
      if (!d) return d;
      const i = d.jobs.findIndex((j) => j.id === job.id);
      const jobs = i >= 0 ? d.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...d.jobs];
      return { ...d, jobs };
    });
    // No "Đã tải xong" toasts: progress is live on the Tải về page and in search
    // rows. Only errors of downloads you started by hand are worth a toast.
    if (job.status === "error" && job.origin === "user" && !isAutoplayJob(job.id)) toast(t("ui.toast.downloadError", { target: job.title ? tsv(job.title) : job.url }), "error");
    onJobEvent(job);
    onJobForPlay(job);
    onJobForList(job); // "Phát tất cả" on a YouTube Music album / playlist
  });
  // Loudness measured in the background after a download.
  es.addEventListener("trackGain", (e) => {
    const { id, gainDb } = JSON.parse((e as MessageEvent).data) as { id: string; gainDb: number };
    usePlayer.getState().patchTrack(id, { gainDb });
    engine.refreshNorm();
  });
  // Another device of this user started / paused / changed song.
  es.addEventListener("playback", (e) => onRemotePlayback(JSON.parse((e as MessageEvent).data) as RemoteSession));
  es.addEventListener("jobRemoved", () => queryClient.invalidateQueries({ queryKey: ["jobs"] }));
  es.addEventListener("jobsCleared", () => queryClient.invalidateQueries({ queryKey: ["jobs"] }));
  const lib = () => {
    if (libTimer) clearTimeout(libTimer);
    libTimer = window.setTimeout(invalidateLibrary, 400); // coalesce bursts (playlist downloads)
  };
  es.addEventListener("library", lib);
  es.addEventListener("playlists", () => {
    queryClient.invalidateQueries({ queryKey: ["playlists"] });
    queryClient.invalidateQueries({ queryKey: ["playlist"] });
  });
  es.addEventListener("settings", (e) => queryClient.setQueryData(["settings"], JSON.parse((e as MessageEvent).data) as Settings));
  es.addEventListener("autodl", () => queryClient.invalidateQueries({ queryKey: ["autodl"] }));
  es.addEventListener("recs", () => {
    queryClient.invalidateQueries({ queryKey: ["home"] });
    queryClient.invalidateQueries({ queryKey: ["foryou"] });
  });
  // Data wiped (possibly from another device): drop the local queue and start fresh.
  es.addEventListener("reset", (e) => {
    const { scope } = JSON.parse((e as MessageEvent).data) as { scope: string };
    if (scope === "all") {
      localStorage.removeItem("rii-player");
      localStorage.removeItem("rii-pos");
      location.replace("/");
    } else {
      queryClient.invalidateQueries();
    }
  });
  es.onopen = () => queryClient.invalidateQueries({ queryKey: ["jobs"] });
}

export function disconnectEvents() {
  es?.close();
  es = null;
}
