// Main-thread coordinator for AI instrumental separation and caching.
import { streamUrl } from "@/lib/api";
import { engine } from "@/player/engine";
import { usePlayer } from "@/player/store";
import { SAMPLE_RATE } from "./dsp";
import { registerInstrumental } from "./source";
import { useKaraoke } from "./store";
import type { WorkerIn, WorkerOut } from "./worker";

const CACHE_NAME = "rii-karaoke";
const MODEL_URL = "/api/karaoke/model";
const CACHE_KEY_RE = /^\/karaoke\/([^/]+)\.wav$/;

const cacheKey = (trackId: string) => `/karaoke/${trackId}.wav`;

const objectUrls = new Map<string, string>();
let activeWorker: Worker | null = null;
let activeTrackId: string | null = null;
let jobSeq = 0;

function terminateActiveWorker(): void {
  if (activeWorker) {
    try {
      activeWorker.postMessage({ type: "cancel" } satisfies WorkerIn);
    } catch {
      /* ignore */
    }
    activeWorker.terminate();
    activeWorker = null;
  }
  activeTrackId = null;
}

function registerCachedBlob(trackId: string, blob: Blob): void {
  const prev = objectUrls.get(trackId);
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(blob);
  objectUrls.set(trackId, url);
  registerInstrumental(trackId, url);
  useKaraoke.setState((s) => (s.ready[trackId] ? s : { ready: { ...s.ready, [trackId]: true } }));
  engine.refreshKaraokeSource();
}

async function decodeTo44100Stereo(bytes: ArrayBuffer): Promise<{ left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> }> {
  const decodeCtx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const decoded = await decodeCtx.decodeAudioData(bytes);

  let buf = decoded;
  if (decoded.sampleRate !== SAMPLE_RATE) {
    const targetLen = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const resampleCtx = new OfflineAudioContext(2, targetLen, SAMPLE_RATE);
    const src = resampleCtx.createBufferSource();
    src.buffer = decoded;
    src.connect(resampleCtx.destination);
    src.start(0);
    buf = await resampleCtx.startRendering();
  }

  const left = new Float32Array(buf.getChannelData(0));
  const right = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : new Float32Array(left);
  return { left, right };
}

function encodeWav16(left: Float32Array, right: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = Math.min(left.length, right.length);
  const numChannels = 2;
  const bytesPerSample = 2;
  const dataBytes = numSamples * numChannels * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    view.setInt16(offset, l < 0 ? Math.round(l * 32768) : Math.round(l * 32767), true);
    offset += 2;
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, r < 0 ? Math.round(r * 32768) : Math.round(r * 32767), true);
    offset += 2;
  }

  return buf;
}

/**
 * Ensures an AI-separated instrumental exists for `trackId`, loading from Cache
 * Storage if available or running the ONNX Web Worker otherwise.
 */
/** Where the model ran last (shown next to the progress). */
let lastBackend: string | undefined;

export async function ensureInstrumental(trackId: string): Promise<void> {
  if (!trackId) return;

  // Already registered in memory.
  if (objectUrls.has(trackId)) {
    useKaraoke.setState((s) => (s.ready[trackId] ? s : { ready: { ...s.ready, [trackId]: true } }));
    return;
  }

  // Already running for this track.
  if (activeTrackId === trackId) return;

  // One job at a time: cancel any running job for a previous track.
  const mySeq = ++jobSeq;
  terminateActiveWorker();
  const isStale = () => mySeq !== jobSeq;

  // 1. Check Cache Storage.
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(cacheKey(trackId));
      if (isStale()) return;
      if (hit) {
        const blob = await hit.blob();
        if (isStale()) return;
        registerCachedBlob(trackId, blob);
        return;
      }
    } catch {
      // Fall through to separation if cache read fails.
    }
  }

  activeTrackId = trackId;
  useKaraoke.setState({ sep: { trackId, phase: "decode", progress: 0 } });

  let worker: Worker | null = null;
  try {
    // 2. Fetch and decode audio to 44.1 kHz stereo.
    const res = await fetch(streamUrl(trackId), { credentials: "include" });
    if (isStale()) return;
    if (!res.ok) {
      throw new Error(`Audio fetch failed: HTTP ${res.status}`);
    }
    const audioBytes = await res.arrayBuffer();
    if (isStale()) return;

    const { left, right } = await decodeTo44100Stereo(audioBytes);
    if (isStale()) return;

    // 3. Run separation in the module worker.
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    activeWorker = worker;

    const separated = await new Promise<{ left: Float32Array; right: Float32Array }>((resolve, reject) => {
      if (!worker) {
        reject(new Error("Worker unavailable"));
        return;
      }
      worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
        if (isStale()) return;
        const msg = ev.data;
        if (msg.type === "backend") {
          lastBackend = msg.name;
        } else if (msg.type === "progress") {
          useKaraoke.setState({ sep: { trackId, phase: msg.phase, progress: msg.progress, backend: lastBackend } });
        } else if (msg.type === "done") {
          resolve({ left: msg.left, right: msg.right });
        } else if (msg.type === "error") {
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (ev: ErrorEvent) => {
        if (isStale()) return;
        reject(new Error(ev.message || "Separation worker error"));
      };
      worker.postMessage(
        { type: "run", modelUrl: MODEL_URL, left, right } satisfies WorkerIn,
        [left.buffer, right.buffer],
      );
    });

    if (isStale()) return;

    // 4. Encode 16-bit PCM WAV, cache, register, and notify engine.
    useKaraoke.setState({ sep: { trackId, phase: "save", progress: 0 } });
    const wav = encodeWav16(separated.left, separated.right, SAMPLE_RATE);
    const blob = new Blob([wav], { type: "audio/wav" });

    if (typeof caches !== "undefined") {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(cacheKey(trackId), new Response(blob, { headers: { "Content-Type": "audio/wav" } }));
      } catch {
        // Ignore cache quota errors; playback still uses the in-memory object URL.
      }
    }

    if (isStale()) return;
    registerCachedBlob(trackId, blob);
    useKaraoke.setState({ sep: { trackId, phase: "done", progress: 1 } });
  } catch (err: unknown) {
    if (isStale()) return;
    const message = err instanceof Error ? err.message : String(err);
    useKaraoke.setState({ sep: { trackId, phase: "error", progress: 0, error: message } });
  } finally {
    if (worker && activeWorker === worker) {
      worker.terminate();
      activeWorker = null;
    }
    if (!isStale()) {
      activeTrackId = null;
    }
  }
}

/** Populates `useKaraoke.ready` from cached instrumentals in Cache Storage. */
export async function loadCachedInstrumentals(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const ready: Record<string, true> = {};
    for (const req of keys) {
      const m = CACHE_KEY_RE.exec(new URL(req.url).pathname);
      if (m) ready[m[1]] = true;
    }
    if (Object.keys(ready).length > 0) {
      useKaraoke.setState((s) => ({ ready: { ...s.ready, ...ready } }));
    }
  } catch {
    /* ignore */
  }
}

/** Deletes all cached instrumentals and returns the total bytes freed. */
export async function clearInstrumentals(): Promise<number> {
  ++jobSeq;
  terminateActiveWorker();

  for (const url of objectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  objectUrls.clear();

  let freed = 0;
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      for (const req of keys) {
        const res = await cache.match(req);
        if (res) {
          const blob = await res.blob();
          freed += blob.size;
        }
      }
      await caches.delete(CACHE_NAME);
    } catch {
      /* ignore */
    }
  }

  useKaraoke.setState({ ready: {}, sep: null });
  return freed;
}

let autoStop: (() => void) | null = null;

/**
 * Subscribes to current track and karaoke mode; triggers separation whenever
 * mode is "ai" and the current track has no registered instrumental yet.
 */
export function startKaraokeAuto(): () => void {
  if (autoStop) return autoStop;

  const check = () => {
    if (useKaraoke.getState().mode !== "ai") return;
    const trackId = usePlayer.getState().current?.track.id;
    if (!trackId) return;
    if (!objectUrls.has(trackId)) {
      void ensureInstrumental(trackId);
    }
  };

  let prevTrackId = usePlayer.getState().current?.track.id ?? null;
  let prevMode = useKaraoke.getState().mode;

  const unsubPlayer = usePlayer.subscribe((s) => {
    const id = s.current?.track.id ?? null;
    if (id !== prevTrackId) {
      prevTrackId = id;
      check();
    }
  });

  const unsubKaraoke = useKaraoke.subscribe((s) => {
    if (s.mode !== prevMode) {
      prevMode = s.mode;
      check();
    }
  });

  check();

  autoStop = () => {
    unsubPlayer();
    unsubKaraoke();
    autoStop = null;
  };
  return autoStop;
}
