// Offline listening (Cài đặt → Nghe offline, off by default).
// When on: the service worker keeps the library data for offline use, songs
// you listen to are stored in IndexedDB for the chosen number of days, and
// "Tải về máy" in a song's ⋯ menu keeps one until you remove it. The service
// worker plays stored songs from IndexedDB, with or without a connection.

import { create } from "zustand";
import { streamUrl, type Track } from "./api";
import { OFFLINE_DEFAULT, clearAudio, deleteAudio, getAudio, getSettings, listAudio, putAudio, putSettings, type OfflineSettings } from "@/offline/idb";
import { usePlayback, usePlayer } from "@/player/store";

type State = OfflineSettings & {
  loaded: boolean;
  online: boolean;
  /** track id → pinned ("Tải về máy") or not */
  stored: Map<string, boolean>;
  bytes: number;
  /** track ids being stored right now */
  busy: Set<string>;
};

export const useOffline = create<State>(() => ({ ...OFFLINE_DEFAULT, loaded: false, online: navigator.onLine, stored: new Map(), bytes: 0, busy: new Set() }));

let started = false;
const AUTO_AFTER_MS = 20_000; // only songs actually listened to, not skipped ones

export async function initOffline() {
  if (started) return;
  started = true;
  const s = await getSettings();
  useOffline.setState({ ...s, loaded: true });
  await refresh();
  void evict();
  window.addEventListener("online", () => useOffline.setState({ online: true }));
  window.addEventListener("offline", () => useOffline.setState({ online: false }));

  // Auto-store the song playing once it has played for a while.
  let timer: number | null = null;
  usePlayer.subscribe((p, prev) => {
    if (p.current?.uid === prev.current?.uid) return;
    if (timer) clearTimeout(timer);
    const track = p.current?.track;
    const o = useOffline.getState();
    if (!track || !o.enabled || !o.autoCache || o.stored.has(track.id)) return;
    timer = window.setTimeout(() => {
      if (usePlayer.getState().current?.track.id === track.id && usePlayback.getState().isPlaying) void storeTrack(track, false);
    }, AUTO_AFTER_MS);
  });
}

export async function setOffline(p: Partial<OfflineSettings>) {
  const next = { ...pick(useOffline.getState()), ...p };
  useOffline.setState(next);
  await putSettings(next);
  if (p.enabled) {
    // Ask the browser not to clear our storage under pressure.
    await navigator.storage?.persist?.().catch(() => false);
  }
  if (p.enabled === false) navigator.serviceWorker?.controller?.postMessage({ type: "clear-api-cache" });
  if (p.retentionDays) void evict();
}

function pick(s: State): OfflineSettings {
  return { enabled: s.enabled, retentionDays: s.retentionDays, autoCache: s.autoCache };
}

async function refresh() {
  try {
    const all = await listAudio();
    useOffline.setState({ stored: new Map(all.map((e) => [e.id, e.pinned])), bytes: all.reduce((n, e) => n + e.size, 0) });
  } catch {
    /* IndexedDB unavailable (private mode): offline listening just doesn't work */
  }
}

// One download at a time.
let chain: Promise<unknown> = Promise.resolve();

/** Store a song on this device; pinned = "Tải về máy" (kept until removed). */
export function storeTrack(t: Track, pinned: boolean): Promise<void> {
  const run = async () => {
    const existing = await getAudio(t.id);
    if (existing) {
      if (pinned && !existing.pinned) await putAudio({ ...existing, pinned: true });
      return refresh();
    }
    useOffline.setState((s) => ({ busy: new Set(s.busy).add(t.id) }));
    try {
      const res = await fetch(streamUrl(t.id), { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const now = Date.now();
      await putAudio({ id: t.id, blob, mime: blob.type || t.mime || "audio/mp4", size: blob.size, cachedAt: now, lastUsedAt: now, pinned, title: t.title, artist: t.artist });
    } finally {
      useOffline.setState((s) => {
        const busy = new Set(s.busy);
        busy.delete(t.id);
        return { busy };
      });
      await refresh();
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

export async function removeStored(id: string) {
  await deleteAudio(id);
  await refresh();
}

export async function clearStored() {
  await clearAudio();
  await refresh();
}

/** Drop songs stored while listening that weren't played within the retention. */
export async function evict() {
  const { retentionDays } = useOffline.getState();
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  try {
    for (const e of await listAudio()) {
      if (!e.pinned && e.lastUsedAt < cutoff) await deleteAudio(e.id);
    }
  } finally {
    await refresh();
  }
}
