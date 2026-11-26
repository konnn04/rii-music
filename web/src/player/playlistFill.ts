// "Phát tất cả" on an album / playlist from YouTube Music: play it without
// saving it as a playlist. Songs already on the server play at once; the
// others are downloaded. The queue always keeps the list's order: song N joins
// it only once every song before it is there (or failed), so playback starts
// with the first song and waits at a song still downloading.

import { api, type Job, type Track, type WebResult } from "@/lib/api";
import { routeRemote, usePlayback, usePlayer, newUid, type QueueEntry, type Source } from "./store";

type Follow = {
  source: Source;
  /** video ids in list order */
  order: Map<string, number>;
  total: number;
  /** job id → video id, for songs still downloading */
  pending: Map<string, string>;
  /** list position → track, ready but not yet in the queue */
  ready: Map<number, Track>;
  /** list positions that will never come (download failed) */
  failed: Set<number>;
  /** next list position to append to the queue */
  next: number;
  started: boolean;
};

let follow: Follow | null = null;
/** Playback stopped at the end of the queue while songs were still coming. */
let stalled = false;

/** Play a YouTube Music album / playlist now, downloading what is missing. */
export async function playWebList(listId: string, name: string, items: WebResult[]) {
  const source: Source = { type: "search", id: "web:" + listId, name };
  const f: Follow = {
    source,
    order: new Map(items.map((r, i) => [r.id, i])),
    total: items.length,
    pending: new Map(),
    ready: new Map(),
    failed: new Set(),
    next: 0,
    started: false,
  };
  follow = f;
  stalled = false;

  // Songs in the library: their track id is known. The rest go through downloads
  // (instant for songs another user already downloaded).
  const known: { pos: number; id: string }[] = [];
  items.forEach((r, i) => r.inLibrary && known.push({ pos: i, id: r.inLibrary }));
  const missing = items.filter((r) => !r.inLibrary);
  if (missing.length) {
    const res = await api<{ jobs: Job[] }>("/api/downloads", { method: "POST", json: { input: missing.map((r) => r.url).join("\n") } });
    const seen = new Set<number>();
    for (const j of res.jobs ?? []) {
      const pos = j.sourceId ? f.order.get(j.sourceId) : undefined;
      if (pos === undefined) continue;
      seen.add(pos);
      if ((j.status === "done" || j.status === "skipped") && j.trackId) known.push({ pos, id: j.trackId });
      else if (j.status === "error") f.failed.add(pos);
      else f.pending.set(j.id, j.sourceId);
    }
    // A song that got no job at all would block the list forever.
    items.forEach((r, i) => !r.inLibrary && !seen.has(i) && f.failed.add(i));
  }
  const tracks = await Promise.all(known.map((k) => api<Track>(`/api/tracks/${k.id}`).catch(() => null)));
  if (follow !== f) return; // another list was started meanwhile
  tracks.forEach((t, i) => (t ? f.ready.set(known[i].pos, t) : f.failed.add(known[i].pos)));
  flush(f);
  return { ready: f.next, downloading: f.pending.size };
}

/** Called by the engine when the last song ended with nothing after it. */
export function notifyPlaylistQueueEnded() {
  stalled = !!follow && follow.next < follow.total && usePlayer.getState().source?.id === follow.source.id;
}

/** Fed from the SSE "job" event. */
export function onJobForList(job: Job) {
  const f = follow;
  const vid = f?.pending.get(job.id);
  if (!f || !vid) return;
  const pos = f.order.get(vid)!;
  if (job.status === "error") {
    f.pending.delete(job.id);
    f.failed.add(pos);
    flush(f);
    return;
  }
  if ((job.status !== "done" && job.status !== "skipped") || !job.trackId) return;
  f.pending.delete(job.id);
  void api<Track>(`/api/tracks/${job.trackId}`).then(
    (t) => {
      f.ready.set(pos, t);
      flush(f);
    },
    () => {
      f.failed.add(pos);
      flush(f);
    },
  );
}

/** Append every song that is now next in line, in the list's order. */
function flush(f: Follow) {
  if (follow !== f) return;
  const batch: Track[] = [];
  while (f.next < f.total) {
    if (f.failed.has(f.next)) {
      f.next++;
      continue;
    }
    const t = f.ready.get(f.next);
    if (!t) break;
    f.ready.delete(f.next);
    batch.push(t);
    f.next++;
  }
  if (!batch.length) return;
  if (!f.started) {
    f.started = true;
    usePlayer.getState().playList(batch, 0, f.source, { shuffle: false });
    return;
  }
  // Another device leads (remote control): the rest of the list goes to its queue.
  if (routeRemote("queue", batch)) return;
  const s = usePlayer.getState();
  if (s.source?.id !== f.source.id) return; // the user moved on to something else
  const fresh = batch.filter((t) => !s.context.some((e) => e.track.id === t.id));
  if (!fresh.length) return;
  const entries: QueueEntry[] = fresh.map((t) => ({ uid: newUid(), track: t }));
  // At the end of the list's songs, before autoplay suggestions.
  let end = s.context.length;
  while (end > s.pos + 1 && s.context[end - 1].auto) end--;
  const context = [...s.context.slice(0, end), ...entries, ...s.context.slice(end)];
  usePlayer.setState({ context, original: s.original ? [...s.original, ...entries] : null });
  if (stalled && !usePlayback.getState().isPlaying) {
    stalled = false;
    usePlayer.getState().advance();
  }
}
