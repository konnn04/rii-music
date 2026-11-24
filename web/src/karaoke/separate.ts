// Main-thread coordinator for streaming AI instrumental separation and caching.
import { streamUrl } from "@/lib/api";
import { engine } from "@/player/engine";
import { usePlayback, usePlayer } from "@/player/store";
import { SAMPLE_RATE } from "./dsp";
import { MODELS, modelUrls, type ModelId } from "./models";
import { registerInstrumental, unregisterInstrumental } from "./source";
import { useKaraoke } from "./store";
import { KaraokeStream } from "./stream";
import type { WorkerIn, WorkerOut } from "./worker";

const CACHE_NAME = "rii-karaoke";
const MODEL_CACHE = "rii-karaoke-model";
// /karaoke/<model>/<track>.wav; the first version stored HQ_3 results as /karaoke/<track>.wav.
const CACHE_KEY_RE = /^\/karaoke\/(?:(spleeter|kara|kara2|hq3)\/)?([^/]+)\.wav$/;
const CACHED_SEG_LEN = SAMPLE_RATE * 10;
const TRACK_CHANGE_DISPOSE_MS = 12_000;
const SYNC_INTERVAL_MS = 1000;

const cacheKey = (model: ModelId, trackId: string) => `/karaoke/${model}/${trackId}.wav`;
const cacheKeys = (model: ModelId, trackId: string) => (model === "hq3" ? [cacheKey(model, trackId), `/karaoke/${trackId}.wav`] : [cacheKey(model, trackId)]);
const curModel = () => useKaraoke.getState().model;

const objectUrls = new Map<string, string>();
let activeWorker: Worker | null = null;
let activeTrackId: string | null = null;
let jobSeq = 0;

type ActiveStream = {
  trackId: string;
  stream: KaraokeStream;
  dest: AudioNode;
  el: HTMLMediaElement;
  syncTimer: number;
  unsubMedia: () => void;
  unsubGap: () => void;
};

let activeStream: ActiveStream | null = null;
const retiringStreams = new Set<{ stream: KaraokeStream; timer: number }>();

function terminateActiveWorker(): void {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
  activeTrackId = null;
}

function detachActiveStream(delayMs = 0): void {
  if (!activeStream) return;
  const cur = activeStream;
  activeStream = null;
  clearInterval(cur.syncTimer);
  cur.unsubMedia();
  cur.unsubGap();

  const nextDest = delayMs > 0 ? (engine.karaokeTarget()?.dest ?? null) : null;
  const keepForCrossfade = delayMs > 0 && nextDest !== null && nextDest !== cur.dest;

  if (keepForCrossfade) {
    if (cur.el.paused) cur.stream.sync(cur.el);
    const entry = {
      stream: cur.stream,
      timer: window.setTimeout(() => {
        retiringStreams.delete(entry);
        cur.stream.dispose(0.05);
      }, delayMs),
    };
    retiringStreams.add(entry);
  } else {
    if (delayMs === 0) engine.setKaraokeCovered(false);
    cur.stream.dispose(0.05);
  }
}

function disposeAllStreams(): void {
  detachActiveStream(0);
  for (const entry of retiringStreams) {
    clearTimeout(entry.timer);
    entry.stream.dispose(0);
  }
  retiringStreams.clear();
}

async function attachStream(trackId: string, isStale: () => boolean): Promise<KaraokeStream | null> {
  if (activeStream) {
    detachActiveStream(activeStream.trackId === trackId ? 0 : TRACK_CHANGE_DISPOSE_MS);
  }
  const target = engine.karaokeTarget();
  if (!target) return null;

  let stream: KaraokeStream;
  try {
    stream = await KaraokeStream.create(target.ctx, target.dest);
  } catch {
    return null;
  }
  if (isStale()) {
    stream.dispose(0);
    return null;
  }

  const updateCoverage = (isGap?: boolean) => {
    if (activeStream?.stream !== stream) return;
    const t = target.el.currentTime || 0;
    const covered = isGap === undefined ? stream.covers(t) : !isGap;
    engine.setKaraokeCovered(covered);
    useKaraoke.setState((s) =>
      s.sep && s.sep.trackId === trackId && s.sep.inGap !== !covered ? { sep: { ...s.sep, inGap: !covered } } : s,
    );
  };

  const unsubGap = stream.onGap((gap) => updateCoverage(gap));
  const unsubMedia = engine.onMediaEvent((_ev, el) => {
    if (el !== target.el || activeStream?.stream !== stream) return;
    stream.sync(el);
    updateCoverage();
  });
  const syncTimer = window.setInterval(() => {
    if (activeStream?.stream !== stream) return;
    stream.sync(target.el);
    updateCoverage();
  }, SYNC_INTERVAL_MS);

  activeStream = { trackId, stream, dest: target.dest, el: target.el, syncTimer, unsubMedia, unsubGap };
  engine.setKaraokeCovered(false);
  return stream;
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

/** Where the model ran last (shown next to the progress). */
let lastBackend: string | undefined;

/** Stop the running separation and fall back to the quick vocal remover
 *  (pressing AI again starts it over). */
export function cancelSeparation(): void {
  jobSeq++;
  terminateActiveWorker();
  detachActiveStream(0);
  useKaraoke.setState({ sep: null, mode: "quick" });
}

/**
 * Ensures an AI-separated instrumental exists for `trackId`, loading from Cache
 * Storage if available or streaming separation from the ONNX Web Worker otherwise.
 */
export async function ensureInstrumental(trackId: string): Promise<void> {
  if (!trackId) return;

  const simple = engine.simpleMode;

  if (simple) {
    if (objectUrls.has(trackId)) {
      useKaraoke.setState((s) => (s.ready[trackId] ? s : { ready: { ...s.ready, [trackId]: true } }));
      return;
    }
  } else if (activeStream?.trackId === trackId && useKaraoke.getState().ready[trackId]) {
    activeStream.stream.sync(activeStream.el);
    engine.setKaraokeCovered(activeStream.stream.covers(activeStream.el.currentTime || 0));
    return;
  }

  // Already running for this track.
  if (activeTrackId === trackId) return;

  // One job at a time: cancel any running job for a previous track.
  const mySeq = ++jobSeq;
  const jobModel = curModel();
  terminateActiveWorker();
  if (activeStream) {
    detachActiveStream(activeStream.trackId === trackId ? 0 : TRACK_CHANGE_DISPOSE_MS);
  }
  const isStale = () => mySeq !== jobSeq;

  // 1. Check Cache Storage.
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      let hit: Response | undefined;
      for (const k of cacheKeys(jobModel, trackId)) hit ??= await cache.match(k);
      if (isStale()) return;
      if (hit) {
        const blob = await hit.blob();
        if (isStale()) return;
        if (simple) {
          registerCachedBlob(trackId, blob);
          useKaraoke.setState({ sep: { trackId, phase: "done", progress: 1 } });
          return;
        }
        const bytes = await blob.arrayBuffer();
        if (isStale()) return;
        const { left, right } = await decodeTo44100Stereo(bytes);
        if (isStale()) return;
        const stream = await attachStream(trackId, isStale);
        if (isStale()) return;
        if (stream && activeStream?.stream === stream) {
          const total = Math.min(left.length, right.length);
          const count = Math.max(1, Math.ceil(total / CACHED_SEG_LEN));
          stream.init(CACHED_SEG_LEN, count, total, SAMPLE_RATE);
          for (let i = 0; i < count; i++) {
            const start = i * CACHED_SEG_LEN;
            const end = Math.min(total, start + CACHED_SEG_LEN);
            stream.add(i, left.subarray(start, end), right.subarray(start, end));
          }
          stream.sync(activeStream.el);
          engine.setKaraokeCovered(true);
        }
        useKaraoke.setState((s) => ({
          ready: s.ready[trackId] ? s.ready : { ...s.ready, [trackId]: true },
          sep: { trackId, phase: "done", progress: 1 },
        }));
        return;
      }
    } catch {
      // Fall through to separation if cache read or decode fails.
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

    const total = Math.min(left.length, right.length);
    const outLeft = new Float32Array(total);
    const outRight = new Float32Array(total);

    const stream = simple ? null : await attachStream(trackId, isStale);
    if (isStale()) return;

    // 3. Run segmented separation in the module worker.
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    activeWorker = worker;

    let totalSegs = 0;
    await new Promise<void>((resolve, reject) => {
      if (!worker) {
        reject(new Error("Worker unavailable"));
        return;
      }

      let segLen = 0;
      let count = 0;
      let doneCount = 0;
      let doneBitmap: Uint8Array | null = null;

      const pickNextSegment = (): number => {
        if (!doneBitmap || count <= 0) return -1;
        if (simple) {
          for (let i = 0; i < count; i++) {
            if (doneBitmap[i] === 0) return i;
          }
          return -1;
        }
        const pos = activeStream?.el.currentTime ?? usePlayback.getState().position ?? 0;
        const startSeg = Math.max(0, Math.min(count - 1, Math.floor((pos * SAMPLE_RATE) / segLen)));
        for (let offset = 0; offset < count; offset++) {
          const idx = (startSeg + offset) % count;
          if (doneBitmap[idx] === 0) return idx;
        }
        return -1;
      };

      const requestNext = () => {
        if (!worker || isStale()) return;
        const next = pickNextSegment();
        if (next >= 0) {
          worker.postMessage({ type: "segment", index: next } satisfies WorkerIn);
        } else {
          resolve();
        }
      };

      worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
        if (isStale()) return;
        const msg = ev.data;
        if (msg.type === "backend") {
          lastBackend = msg.name;
        } else if (msg.type === "progress") {
          useKaraoke.setState({ sep: { trackId, phase: msg.phase, progress: msg.progress, backend: lastBackend } });
        } else if (msg.type === "ready") {
          segLen = msg.segLen;
          count = msg.count;
          totalSegs = count;
          doneBitmap = new Uint8Array(count);
          if (stream && activeStream?.stream === stream) {
            stream.init(segLen, count, total, SAMPLE_RATE);
            stream.sync(activeStream.el);
          }
          useKaraoke.setState({
            sep: {
              trackId,
              phase: "separate",
              progress: 0,
              backend: lastBackend,
              doneSegs: 0,
              totalSegs: count,
              inGap: !!stream,
            },
          });
          requestNext();
        } else if (msg.type === "segment") {
          const start = msg.index * segLen;
          const len = Math.min(msg.left.length, msg.right.length, total - start);
          if (len > 0) {
            outLeft.set(msg.left.subarray(0, len), start);
            outRight.set(msg.right.subarray(0, len), start);
          }
          if (stream && activeStream?.stream === stream) {
            stream.add(msg.index, msg.left, msg.right);
            const covered = stream.covers(activeStream.el.currentTime || 0);
            if (covered) engine.setKaraokeCovered(true);
          }
          if (doneBitmap && msg.index >= 0 && msg.index < doneBitmap.length && doneBitmap[msg.index] === 0) {
            doneBitmap[msg.index] = 1;
            doneCount++;
          }
          const inGap = stream && activeStream?.stream === stream ? !stream.covers(activeStream.el.currentTime || 0) : false;
          useKaraoke.setState({
            sep: {
              trackId,
              phase: "separate",
              progress: count > 0 ? doneCount / count : 1,
              backend: lastBackend,
              doneSegs: doneCount,
              totalSegs: count,
              inGap,
            },
          });
          requestNext();
        } else if (msg.type === "error") {
          reject(new Error(msg.message));
        }
      };

      worker.onerror = (ev: ErrorEvent) => {
        if (isStale()) return;
        reject(new Error(ev.message || "Separation worker error"));
      };

      const leftCopy = new Float32Array(left);
      const rightCopy = new Float32Array(right);
      worker.postMessage({ type: "load", model: MODELS[jobModel], urls: modelUrls(jobModel) } satisfies WorkerIn);
      worker.postMessage({ type: "audio", left: leftCopy, right: rightCopy } satisfies WorkerIn, [leftCopy.buffer, rightCopy.buffer]);
    });

    if (isStale()) return;

    // 4. Encode 16-bit PCM WAV, cache, and mark ready.
    useKaraoke.setState({
      sep: {
        trackId,
        phase: "save",
        progress: 1,
        backend: lastBackend,
        doneSegs: totalSegs,
        totalSegs,
        inGap: false,
      },
    });
    const wav = encodeWav16(outLeft, outRight, SAMPLE_RATE);
    const blob = new Blob([wav], { type: "audio/wav" });

    if (typeof caches !== "undefined") {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(cacheKey(jobModel, trackId), new Response(blob, { headers: { "Content-Type": "audio/wav" } }));
      } catch {
        // Ignore cache quota errors; playback still uses the live stream or in-memory object URL.
      }
    }

    if (isStale()) return;
    if (simple) {
      registerCachedBlob(trackId, blob);
    } else {
      useKaraoke.setState((s) => (s.ready[trackId] ? s : { ready: { ...s.ready, [trackId]: true } }));
    }
    useKaraoke.setState({ sep: { trackId, phase: "done", progress: 1 } });
  } catch (err: unknown) {
    if (isStale()) return;
    if (!simple && activeStream?.trackId === trackId) {
      detachActiveStream(0);
    }
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
      if (m && (m[1] ?? "hq3") === curModel()) ready[m[2]] = true;
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
  disposeAllStreams();

  for (const [id, url] of objectUrls) {
    URL.revokeObjectURL(url);
    unregisterInstrumental(id);
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
      // The downloaded models too (up to ~150 MB).
      const models = await caches.open(MODEL_CACHE);
      for (const req of await models.keys()) freed += (await (await models.match(req))?.blob())?.size ?? 0;
      await caches.delete(MODEL_CACHE);
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
 * mode is "ai" and the current track has no active instrumental stream (or blob in simple mode).
 */
export function startKaraokeAuto(): () => void {
  if (autoStop) return autoStop;

  const check = () => {
    if (useKaraoke.getState().mode !== "ai") return;
    const trackId = usePlayer.getState().current?.track.id;
    if (!trackId) return;
    if (engine.simpleMode) {
      if (!objectUrls.has(trackId)) {
        void ensureInstrumental(trackId);
      }
    } else if (activeStream?.trackId !== trackId) {
      void ensureInstrumental(trackId);
    }
  };

  let prevTrackId = usePlayer.getState().current?.track.id ?? null;
  let prevMode = useKaraoke.getState().mode;

  const unsubPlayer = usePlayer.subscribe((s) => {
    const id = s.current?.track.id ?? null;
    if (id !== prevTrackId) {
      prevTrackId = id;
      jobSeq++;
      terminateActiveWorker();
      detachActiveStream(TRACK_CHANGE_DISPOSE_MS);
      check();
    }
  });

  let prevModel = useKaraoke.getState().model;
  const unsubKaraoke = useKaraoke.subscribe((s) => {
    if (s.model !== prevModel) {
      // Another model: drop this one's instrumentals from memory (the cache keeps
      // them per model) and start over with the new one.
      prevModel = s.model;
      jobSeq++;
      terminateActiveWorker();
      disposeAllStreams();
      for (const [id, url] of objectUrls) {
        URL.revokeObjectURL(url);
        unregisterInstrumental(id);
      }
      objectUrls.clear();
      useKaraoke.setState({ ready: {}, sep: null });
      engine.refreshKaraokeSource();
      void loadCachedInstrumentals();
      check();
      return;
    }
    if (s.mode !== prevMode) {
      prevMode = s.mode;
      if (s.mode !== "ai") {
        // Leaving AI mode (or closing karaoke) stops the separation and stream.
        jobSeq++;
        terminateActiveWorker();
        detachActiveStream(0);
        if (useKaraoke.getState().sep) {
          useKaraoke.setState({ sep: null });
        }
      }
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
