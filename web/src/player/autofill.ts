// "Tự động gợi ý phát" (autoplay): when the queue is about to run out, keep the
// music going like YouTube Music / Spotify do.
//  - Library tracks around the current one come from /api/radio (same artist,
//    similar artists, co-listened, sound-alike) and are appended at once.
//  - Optionally, a couple of songs not in the library yet (same / similar
//    artists, from /api/recs/autoplay) are downloaded in the background and
//    slotted into the queue as soon as they are ready, a few tracks ahead.

import { api, type Job, type Settings, type Track } from "@/lib/api";
import { queryClient } from "@/lib/queries";
import { usePlayback, usePlayer } from "./store";
import { isOffline } from "./net";
import { roomRole } from "./roomFlag";

const LOW_WATER = 5; // refill when fewer upcoming tracks than this
const EXT_MIN = 2;
// The admin sets both (Quản trị → Gợi ý và tải); these are the defaults.
const limits = () => {
  const l = queryClient.getQueryData<Settings>(["settings"])?.limits;
  return { target: l?.autoplayTarget ?? 10, extMax: l?.autoplayDownloads ?? 6 };
};

let inflight = false;
let lastSeed = ""; // one refill per seed entry, so an empty answer isn't retried in a loop
/** Background downloads started by autoplay: job id → seed entry uid. */
const pending = new Map<string, string>();
/** Playback stopped because the queue ran out; resume when a download lands. */
let stalled = false;

type ExtSuggestion = { videoId: string; title: string; artist: string; url: string; reason: string };

export function isAutoplayJob(id: string) {
  return pending.has(id);
}

/** Called by the engine when the last track ended with nothing after it. */
export function notifyQueueEnded() {
  stalled = pending.size > 0 || inflight;
}

function upcomingCount() {
  const s = usePlayer.getState();
  return s.manual.length + Math.max(0, s.context.length - s.pos - 1);
}

async function refill() {
  const s = usePlayer.getState();
  const cur = s.current;
  // Repeat one keeps the queue filling (it only loops the current song); repeat all
  // loops the queue itself, so nothing is added then.
  if (s.autoplayMode === "off" || !cur || s.repeat === "all" || inflight || lastSeed === cur.uid) return;
  if (upcomingCount() >= LOW_WATER) return;
  if (isOffline()) return; // no radio or downloads without the server
  if (roomRole() === "listener") return; // the room decides what plays

  inflight = true;
  lastSeed = cur.uid;
  try {
    const radio = await api<{ tracks: Track[] }>(`/api/radio?seed=${encodeURIComponent(cur.track.id)}`).catch(() => ({ tracks: [] as Track[] }));
    const now = usePlayer.getState();
    if (now.autoplayMode === "off") return;
    // Nothing already in the queue, played or upcoming (the server also leaves
    // out songs finished in the last 3 hours).
    const skip = new Set([...now.context, ...now.manual].map((e) => e.track.id));
    skip.add(cur.track.id);
    const { target, extMax } = limits();
    const want = Math.max(target - upcomingCount(), LOW_WATER);
    const pick = radio.tracks.filter((t) => !skip.has(t.id)).slice(0, want);
    if (pick.length) now.appendAuto(pick);

    // Free mode: download new songs too, more of them when the library is short.
    const extN = Math.min(extMax, Math.max(Math.min(EXT_MIN, extMax), want - pick.length)) - pending.size;
    const ext =
      s.autoplayMode === "free" && extN > 0
        ? await api<{ external: ExtSuggestion[] }>(`/api/recs/autoplay?seed=${encodeURIComponent(cur.track.id)}&ext=${extN}`).catch(() => ({ external: [] as ExtSuggestion[] }))
        : { external: [] as ExtSuggestion[] };

    for (const x of ext.external) {
      try {
        const r = await api<{ jobs: Job[] }>("/api/downloads", { method: "POST", json: { input: x.url, origin: "autoplay" } });
        for (const j of r.jobs ?? []) {
          if (j.status === "done" || j.status === "skipped") {
            if (j.trackId) void insertDownloaded(j.trackId);
          } else {
            pending.set(j.id, cur.uid);
          }
        }
      } catch {
        // download refused (e.g. too long): just skip it
      }
    }
  } finally {
    inflight = false;
    if (stalled && pending.size === 0) stalled = false;
  }
}

/** A background download finished: put the track a couple of places ahead. */
async function insertDownloaded(trackId: string) {
  const s = usePlayer.getState();
  if (s.autoplayMode === "off" || !s.current) return;
  if (s.context.some((e) => e.track.id === trackId) || s.manual.some((e) => e.track.id === trackId)) return;
  let t: Track;
  try {
    t = await api<Track>(`/api/tracks/${trackId}`);
  } catch {
    return;
  }
  const st = usePlayer.getState();
  // Two places ahead keeps the next track (already preloaded) untouched; when
  // the queue is shorter, it simply goes last.
  st.insertAuto(t, Math.min(st.pos + 2, st.context.length - 1) + 1);
  if (stalled && !usePlayback.getState().isPlaying) {
    stalled = false;
    usePlayer.getState().advance();
  }
}

/** Fed from the SSE "job" event. */
export function onJobEvent(job: Job) {
  if (!pending.has(job.id)) return;
  if (job.status === "done" || job.status === "skipped") {
    pending.delete(job.id);
    if (job.trackId) void insertDownloaded(job.trackId);
  } else if (job.status === "error") {
    pending.delete(job.id);
    if (stalled && pending.size === 0) stalled = false;
  }
}

let started = false;
export function startAutofill() {
  if (started) return;
  started = true;
  usePlayer.subscribe((s, prev) => {
    if (s.autoplayMode !== prev.autoplayMode) lastSeed = "";
    if (
      s.current?.uid !== prev.current?.uid ||
      s.context.length !== prev.context.length ||
      s.manual.length !== prev.manual.length ||
      s.autoplayMode !== prev.autoplayMode ||
      s.repeat !== prev.repeat
    ) {
      void refill();
    }
  });
  void refill();
}
