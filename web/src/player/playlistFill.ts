// "Phát tất cả" on an album / playlist from YouTube Music: play it without
// saving it as a playlist. Songs already on the server play at once; the
// others are downloaded and slotted into the queue, in the list's order, as
// each download lands. With nothing ready yet, playback starts with the first
// song done.

import { api, type Job, type Track, type WebResult } from "@/lib/api";
import { usePlayback, usePlayer, newUid, type QueueEntry, type Source } from "./store";

type Follow = {
  source: Source;
  /** video ids in list order */
  order: Map<string, number>;
  /** job id → video id, for songs still downloading */
  pending: Map<string, string>;
  /** track id → video id, for songs in the queue */
  vidOf: Map<string, string>;
  started: boolean;
};

let follow: Follow | null = null;
/** Playback stopped at the end of the queue while songs were still coming. */
let stalled = false;

/** Play a YouTube Music album / playlist now, downloading what is missing. */
export async function playWebList(listId: string, name: string, items: WebResult[]) {
  const source: Source = { type: "search", id: "web:" + listId, name };
  const f: Follow = { source, order: new Map(items.map((r, i) => [r.id, i])), pending: new Map(), vidOf: new Map(), started: false };
  follow = f;
  stalled = false;

  // Songs in the library: their track id is known. The rest go through downloads
  // (instant for songs another user already downloaded).
  const ready: { vid: string; id: string }[] = items.filter((r) => r.inLibrary).map((r) => ({ vid: r.id, id: r.inLibrary }));
  const missing = items.filter((r) => !r.inLibrary);
  if (missing.length) {
    const res = await api<{ jobs: Job[] }>("/api/downloads", { method: "POST", json: { input: missing.map((r) => r.url).join("\n") } });
    for (const j of res.jobs ?? []) {
      if (!j.sourceId || !f.order.has(j.sourceId)) continue;
      if ((j.status === "done" || j.status === "skipped") && j.trackId) ready.push({ vid: j.sourceId, id: j.trackId });
      else if (j.status !== "error") f.pending.set(j.id, j.sourceId);
    }
  }
  ready.sort((a, b) => f.order.get(a.vid)! - f.order.get(b.vid)!);
  const tracks = await Promise.all(ready.map((r) => api<Track>(`/api/tracks/${r.id}`).catch(() => null)));
  if (follow !== f) return; // another list was started meanwhile
  const ok: Track[] = [];
  tracks.forEach((t, i) => {
    if (!t) return;
    f.vidOf.set(t.id, ready[i].vid);
    ok.push(t);
  });
  if (ok.length) {
    f.started = true;
    usePlayer.getState().playList(ok, 0, source, { shuffle: false });
  }
  return { ready: ok.length, downloading: f.pending.size };
}

/** Called by the engine when the last song ended with nothing after it. */
export function notifyPlaylistQueueEnded() {
  stalled = !!follow && follow.pending.size > 0 && usePlayer.getState().source?.id === follow.source.id;
}

/** Fed from the SSE "job" event. */
export function onJobForList(job: Job) {
  const f = follow;
  const vid = f?.pending.get(job.id);
  if (!f || !vid) return;
  if (job.status === "error") {
    f.pending.delete(job.id);
    return;
  }
  if ((job.status !== "done" && job.status !== "skipped") || !job.trackId) return;
  f.pending.delete(job.id);
  void api<Track>(`/api/tracks/${job.trackId}`).then(
    (t) => insert(f, vid, t),
    () => {},
  );
}

function insert(f: Follow, vid: string, t: Track) {
  if (follow !== f) return;
  f.vidOf.set(t.id, vid);
  if (!f.started) {
    f.started = true;
    usePlayer.getState().playList([t], 0, f.source, { shuffle: false });
    return;
  }
  const s = usePlayer.getState();
  if (s.source?.id !== f.source.id) return; // the user moved on to something else
  if (s.context.some((e) => e.track.id === t.id)) return;
  const at = f.order.get(vid)!;
  // Right after the closest earlier song of the list already in the queue.
  let i = -1;
  for (let k = s.context.length - 1; k >= 0; k--) {
    const v = f.vidOf.get(s.context[k].track.id);
    if (v !== undefined && f.order.get(v)! < at && !s.context[k].auto) {
      i = k + 1;
      break;
    }
  }
  if (s.shuffle || i < 0) {
    let end = s.context.length;
    while (end > s.pos + 1 && s.context[end - 1].auto) end--;
    i = s.shuffle ? s.pos + 1 + Math.floor(Math.random() * (end - s.pos)) : s.pos + 1;
  }
  i = Math.max(i, s.pos + 1);
  const e: QueueEntry = { uid: newUid(), track: t };
  const context = [...s.context.slice(0, i), e, ...s.context.slice(i)];
  usePlayer.setState({ context, original: s.original ? [...s.original, e] : null });
  if (stalled && !usePlayback.getState().isPlaying) {
    stalled = false;
    usePlayer.getState().advance();
  }
}
