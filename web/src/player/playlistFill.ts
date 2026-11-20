// "Phát tất cả" on an album / playlist from YouTube Music: it is saved as a
// playlist and its songs download in the background. Songs already on the
// server play at once; the others are slotted into the queue, in playlist
// order, as each download lands (the server announces it with a "playlists"
// event). With nothing ready yet, playback starts with the first song done.

import { api, type Track } from "@/lib/api";
import { usePlayback, usePlayer, newUid, type QueueEntry } from "./store";

/** Playlist waiting for its first downloaded song before playback can start. */
let waiting: { id: string; name: string } | null = null;
/** Playback stopped at the end of the queue while songs were still coming. */
let stalled = false;
const timers = new Map<string, number>();
/** Songs of a followed playlist already seen: only new downloads get inserted (skipped ones stay out). */
const known = new Map<string, Set<string>>();

/** Play a saved web playlist now, and keep its queue in step with downloads. */
export async function playFollowing(id: string, name: string) {
  const pl = await api<{ tracks: Track[] }>(`/api/playlists/${id}`);
  known.set(id, new Set(pl.tracks.map((t) => t.id)));
  if (pl.tracks.length) {
    waiting = null;
    usePlayer.getState().playList(pl.tracks, 0, { type: "playlist", id, name }, { shuffle: false });
  } else {
    waiting = { id, name };
  }
}

/** Called by the engine when the last song ended with nothing after it. */
export function notifyPlaylistQueueEnded() {
  const src = usePlayer.getState().source;
  stalled = src?.type === "playlist";
}

/** Fed from the SSE "playlists" event: a song was added to playlist `id`. */
export function onPlaylistChanged(id: string) {
  const src = usePlayer.getState().source;
  if (waiting?.id !== id && !(src?.type === "playlist" && src.id === id)) return;
  // Coalesce bursts (several songs finishing together).
  clearTimeout(timers.get(id));
  timers.set(id, window.setTimeout(() => void sync(id), 500));
}

async function sync(id: string) {
  timers.delete(id);
  let tracks: Track[];
  try {
    tracks = (await api<{ tracks: Track[] }>(`/api/playlists/${id}`)).tracks;
  } catch {
    return;
  }
  const seen = known.get(id);
  if (!seen) return;
  if (waiting?.id === id) {
    tracks.forEach((t) => seen.add(t.id));
    const w = waiting;
    waiting = null;
    if (tracks.length) usePlayer.getState().playList(tracks, 0, { type: "playlist", id, name: w.name }, { shuffle: false });
    return;
  }
  const s = usePlayer.getState();
  if (s.source?.type !== "playlist" || s.source.id !== id) return;
  const missing = tracks.filter((t) => !seen.has(t.id));
  missing.forEach((t) => seen.add(t.id));
  if (!missing.length) return;

  // Put each new song right after the closest earlier playlist song already
  // in the queue, so the queue follows the playlist order.
  const context = s.context.slice();
  const order = new Map(tracks.map((t, i) => [t.id, i]));
  const added: QueueEntry[] = [];
  for (const t of missing) {
    const at = order.get(t.id)!;
    let insert = -1;
    for (let i = context.length - 1; i >= 0; i--) {
      const o = order.get(context[i].track.id);
      if (o !== undefined && o < at && !context[i].auto) {
        insert = i + 1;
        break;
      }
    }
    if (insert < 0) insert = s.pos + 1;
    insert = Math.max(insert, s.pos + 1);
    if (s.shuffle) {
      // Shuffled: anywhere among the upcoming songs of the list.
      let end = context.length;
      while (end > s.pos + 1 && context[end - 1].auto) end--;
      insert = s.pos + 1 + Math.floor(Math.random() * (end - s.pos));
    }
    const e: QueueEntry = { uid: newUid(), track: t };
    context.splice(insert, 0, e);
    added.push(e);
  }
  usePlayer.setState({ context, original: s.original ? [...s.original, ...added] : null });

  if (stalled && !usePlayback.getState().isPlaying) {
    stalled = false;
    usePlayer.getState().advance();
  }
}
