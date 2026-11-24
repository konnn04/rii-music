import { streamUrl } from "@/lib/api";
import { VocalRemover } from "../quick";

export type AudioChoice = "ai" | "quick" | "original";

export const TARGET_SAMPLE_RATE = 44100;

const KARAOKE_CACHE = "rii-karaoke";
const AI_MODELS = ["kara2", "hq3", "kara", "spleeter"] as const;

export function makeAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError();
}

/**
 * Look up a cached AI instrumental WAV for this track in Cache Storage.
 * Returns the first matching cache key, or null if none is cached.
 */
export async function findCachedInstrumental(trackId: string): Promise<string | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(KARAOKE_CACHE);
    for (const model of AI_MODELS) {
      const key = `/karaoke/${model}/${trackId}.wav`;
      const hit = await cache.match(key);
      if (hit) return key;
    }
    const legacyKey = `/karaoke/${trackId}.wav`;
    if (await cache.match(legacyKey)) return legacyKey;
  } catch {
    /* Cache Storage unavailable or blocked */
  }
  return null;
}

async function decodeToStereo44k(data: ArrayBuffer, signal?: AbortSignal): Promise<AudioBuffer> {
  checkAborted(signal);
  // OfflineAudioContext decodes without requiring a live hardware audio device.
  const decodeCtx = new OfflineAudioContext(2, 1, TARGET_SAMPLE_RATE);
  const decoded = await decodeCtx.decodeAudioData(data.slice(0));
  checkAborted(signal);

  if (decoded.sampleRate === TARGET_SAMPLE_RATE && decoded.numberOfChannels === 2) {
    return decoded;
  }

  const length = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const resampleCtx = new OfflineAudioContext(2, length, TARGET_SAMPLE_RATE);
  const src = resampleCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(resampleCtx.destination);
  src.start(0);
  const rendered = await resampleCtx.startRendering();
  checkAborted(signal);
  return rendered;
}

/**
 * Fetch and prepare the chosen audio track as a 44.1 kHz stereo AudioBuffer.
 */
export async function prepareAudio(
  trackId: string,
  choice: AudioChoice,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  checkAborted(signal);

  if (choice === "ai") {
    const key = await findCachedInstrumental(trackId);
    if (key && typeof caches !== "undefined") {
      const cache = await caches.open(KARAOKE_CACHE);
      const res = await cache.match(key);
      if (res) {
        const buf = await res.arrayBuffer();
        return decodeToStereo44k(buf, signal);
      }
    }
  }

  const res = await fetch(streamUrl(trackId), { credentials: "include", signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const raw = await res.arrayBuffer();
  const base = await decodeToStereo44k(raw, signal);

  if (choice === "quick") {
    checkAborted(signal);
    const offlineCtx = new OfflineAudioContext(2, base.length, base.sampleRate);
    const src = offlineCtx.createBufferSource();
    src.buffer = base;
    const remover = new VocalRemover(offlineCtx);
    remover.setEnabled(true);
    remover.setVocal(0);
    src.connect(remover.input);
    remover.output.connect(offlineCtx.destination);
    src.start(0);
    const processed = await offlineCtx.startRendering();
    checkAborted(signal);
    return processed;
  }

  return base;
}

/**
 * Compute a normalised low-frequency beat energy envelope (0..1) at `fps` frames/sec:
 * 1. Mono mix
 * 2. One-pole low-pass filter (~150 Hz)
 * 3. Per-frame RMS
 * 4. Normalise by the 95th percentile
 * 5. Smooth with fast attack / slow release
 */
export function computeBeatEnvelope(buf: AudioBuffer, fps: number): Float32Array {
  const sr = buf.sampleRate;
  const totalSamples = buf.length;
  const totalFrames = Math.max(1, Math.ceil(buf.duration * fps));
  const out = new Float32Array(totalFrames);
  if (totalSamples === 0) return out;

  const left = buf.getChannelData(0);
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

  // One-pole low-pass at 150 Hz
  const cutoffHz = 150;
  const dt = 1 / sr;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);

  const rms = new Float32Array(totalFrames);
  const samplesPerFrame = sr / fps;
  let lp = 0;

  for (let f = 0; f < totalFrames; f++) {
    const start = Math.floor(f * samplesPerFrame);
    const end = Math.min(totalSamples, Math.floor((f + 1) * samplesPerFrame));
    if (end <= start) continue;

    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const mono = right ? (left[i] + right[i]) * 0.5 : left[i];
      lp += alpha * (mono - lp);
      sumSq += lp * lp;
    }
    rms[f] = Math.sqrt(sumSq / (end - start));
  }

  // Normalise by 95th percentile
  const sorted = Float32Array.from(rms).sort();
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))];
  if (p95 <= 1e-6) return out;

  // Smooth with fast attack / slow release
  const attack = 0.55;
  const release = 0.14;
  let prev = 0;
  for (let f = 0; f < totalFrames; f++) {
    const norm = Math.min(1, rms[f] / p95);
    const coeff = norm > prev ? attack : release;
    prev += coeff * (norm - prev);
    out[f] = prev;
  }

  return out;
}

/**
 * Copy a sample range [startSample, endSample) out of an AudioBuffer into a new AudioBuffer.
 */
export function sliceAudioBuffer(buf: AudioBuffer, startSample: number, endSample: number): AudioBuffer {
  const length = Math.max(1, endSample - startSample);
  const out = new AudioBuffer({
    length,
    numberOfChannels: buf.numberOfChannels,
    sampleRate: buf.sampleRate,
  });
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    out.getChannelData(ch).set(src.subarray(startSample, endSample));
  }
  return out;
}
