// IndexedDB storage for offline listening, shared by the page and the service
// worker (no DOM APIs here).
//   audio:  trackId → { blob, mime, size, cachedAt, lastUsedAt, pinned }
//   meta:   "settings" → OfflineSettings (the service worker reads it too)

export type OfflineSettings = {
  /** Offline mode: cache the app's data and keep songs for listening without a connection. */
  enabled: boolean;
  /** Keep songs cached while listening (not pinned), for this many days since last played. */
  retentionDays: 30 | 60 | 90;
  autoCache: boolean;
};

export const OFFLINE_DEFAULT: OfflineSettings = { enabled: false, retentionDays: 30, autoCache: true };

export type AudioEntry = {
  id: string;
  blob: Blob;
  mime: string;
  size: number;
  cachedAt: number;
  lastUsedAt: number;
  /** "Tải về máy": kept until removed by hand, whatever the retention. */
  pinned: boolean;
  title?: string;
  artist?: string;
};

const DB = "rii-offline";
let dbp: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
  });
  return dbp;
}

function tx<T>(store: "audio" | "meta", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => resolve(r ? r.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export async function getSettings(): Promise<OfflineSettings> {
  try {
    const v = await tx<OfflineSettings>("meta", "readonly", (s) => s.get("settings"));
    return { ...OFFLINE_DEFAULT, ...(v ?? {}) };
  } catch {
    return OFFLINE_DEFAULT;
  }
}

export function putSettings(v: OfflineSettings) {
  return tx("meta", "readwrite", (s) => s.put(v, "settings"));
}

export function getAudio(id: string) {
  return tx<AudioEntry>("audio", "readonly", (s) => s.get(id));
}

export function putAudio(e: AudioEntry) {
  return tx("audio", "readwrite", (s) => s.put(e));
}

export function deleteAudio(id: string) {
  return tx("audio", "readwrite", (s) => s.delete(id));
}

/** Every cached song without its audio (for lists and sizes). */
export async function listAudio(): Promise<Omit<AudioEntry, "blob">[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out: Omit<AudioEntry, "blob">[] = [];
    const t = db.transaction("audio", "readonly");
    const req = t.objectStore("audio").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const { blob: _blob, ...rest } = c.value as AudioEntry;
      out.push(rest);
      c.continue();
    };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

export async function touchAudio(id: string) {
  const e = await getAudio(id);
  if (e) await putAudio({ ...e, lastUsedAt: Date.now() });
}

export function clearAudio() {
  return tx("audio", "readwrite", (s) => s.clear());
}
