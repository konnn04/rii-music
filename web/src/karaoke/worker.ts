// Web Worker: AI vocal separation in independent segments, so the main thread can
// ask for the part at the playhead first and play it while the rest is separated.
// MDX-Net (UVR) and Spleeter 2 stems (sherpa-onnx export), on onnxruntime-web
// (WebGPU when possible, else WASM).
import * as ort from "onnxruntime-web/webgpu";
import { Mdx, SpleeterDsp } from "./dsp";
import type { KaraokeModel } from "./models";

export type WorkerIn =
  | { type: "load"; model: KaraokeModel; urls: string[] }
  | { type: "audio"; left: Float32Array; right: Float32Array }
  | { type: "segment"; index: number };

export type WorkerOut =
  | { type: "progress"; phase: "model"; progress: number }
  | { type: "backend"; name: string }
  | { type: "ready"; segLen: number; count: number }
  | { type: "segment"; index: number; left: Float32Array; right: Float32Array }
  | { type: "error"; message: string };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerIn>) => void) | null;
  postMessage(message: WorkerOut, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const MODEL_CACHE = "rii-karaoke-model";

let model: KaraokeModel | null = null;
let sessions: ort.InferenceSession[] = [];
let audio: { left: Float32Array; right: Float32Array } | null = null;
let mdx: Mdx | null = null;
let spl: SpleeterDsp | null = null;
let readySent = false;
/** Segment requests run one after another. */
let queue: Promise<void> = Promise.resolve();

const post = (m: WorkerOut, transfer?: Transferable[]) => scope.postMessage(m, transfer);

/** Downloads (or reads from Cache Storage) every file of the model; progress over all of them. */
async function fetchModels(urls: string[]): Promise<Uint8Array<ArrayBuffer>[]> {
  const cache = typeof caches !== "undefined" ? await caches.open(MODEL_CACHE) : null;
  const out: Uint8Array<ArrayBuffer>[] = [];
  post({ type: "progress", phase: "model", progress: 0 });
  for (let u = 0; u < urls.length; u++) {
    const url = urls[u];
    const hit = await cache?.match(url);
    if (hit) {
      out.push(new Uint8Array(await hit.arrayBuffer()));
      continue;
    }
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get("Content-Length") || 0);
    const parts: Uint8Array[] = [];
    let loaded = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.byteLength;
        if (total > 0) post({ type: "progress", phase: "model", progress: (u + loaded / total) / urls.length });
      }
    } else {
      const b = new Uint8Array(await res.arrayBuffer());
      parts.push(b);
      loaded = b.byteLength;
    }
    const bytes = new Uint8Array(loaded);
    let off = 0;
    for (const p of parts) {
      bytes.set(p, off);
      off += p.byteLength;
    }
    try {
      await cache?.put(url, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
    } catch {
      /* quota: still usable this time */
    }
    out.push(bytes);
  }
  post({ type: "progress", phase: "model", progress: 1 });
  return out;
}

/** The WebGPU adapter's name as far as the browser tells it. */
function gpuName(): string {
  const dev = ort.env.webgpu.device as { adapterInfo?: { vendor?: string; architecture?: string; description?: string } } | undefined;
  const i = dev?.adapterInfo;
  const name = i?.description || [i?.vendor, i?.architecture].filter(Boolean).join(" ");
  return name ? `GPU · ${name}` : "GPU";
}

async function createSessions(files: Uint8Array<ArrayBuffer>[]): Promise<ort.InferenceSession[]> {
  try {
    // Laptops with two GPUs: ask for the discrete one.
    ort.env.webgpu.powerPreference = "high-performance";
    const s: ort.InferenceSession[] = [];
    for (const f of files) s.push(await ort.InferenceSession.create(f, { executionProviders: ["webgpu"] }));
    post({ type: "backend", name: gpuName() });
    return s;
  } catch {
    const s: ort.InferenceSession[] = [];
    for (const f of files) s.push(await ort.InferenceSession.create(f, { executionProviders: ["wasm"] }));
    post({ type: "backend", name: "cpu" });
    return s;
  }
}

const segLen = () => (mdx ? mdx.gen : spl ? spl.segLen : 0);

function maybeReady() {
  if (readySent || !audio || !sessions.length) return;
  const n = audio.left.length, len = segLen();
  readySent = true;
  post({ type: "ready", segLen: len, count: Math.max(1, Math.ceil(n / len)) });
}

/** Copy x[from, from+len) into a new array, zeros outside the signal. */
function slice(x: Float32Array, from: number, len: number): Float32Array {
  const out = new Float32Array(len);
  const a = Math.max(0, from), b = Math.min(x.length, from + len);
  if (b > a) out.set(x.subarray(a, b), a - from);
  return out;
}

async function segmentMdx(i: number): Promise<{ left: Float32Array; right: Float32Array }> {
  const m = model as Extract<KaraokeModel, { kind: "mdx" }>;
  const d = mdx!;
  const { left, right } = audio!;
  const n = left.length;
  const start = i * d.gen;
  const len = Math.min(d.gen, n - start);
  // Chunk = the segment with trim samples of context on each side.
  const L = slice(left, start - d.trim, d.chunk), R = slice(right, start - d.trim, d.chunk);
  const s = sessions[0];
  const input = new ort.Tensor("float32", d.pack(L, R), [1, 4, m.dimF, m.dimT]);
  const res = await s.run({ [s.inputNames[0]]: input });
  input.dispose?.();
  const out = res[s.outputNames[0]];
  const sep = d.unpack(out.data as Float32Array);
  out.dispose?.();
  const ol = new Float32Array(len), or = new Float32Array(len);
  for (let k = 0; k < len; k++) {
    const a = sep.left[d.trim + k] * m.compensate;
    const b = sep.right[d.trim + k] * m.compensate;
    ol[k] = m.primary === "vocals" ? left[start + k] - a : a;
    or[k] = m.primary === "vocals" ? right[start + k] - b : b;
  }
  return { left: ol, right: or };
}

async function segmentSpleeter(i: number): Promise<{ left: Float32Array; right: Float32Array }> {
  const d = spl!;
  const { left, right } = audio!;
  const n = left.length;
  const start = i * d.segLen;
  const len = Math.min(d.segLen, n - start);
  const L = d.stft(slice(left, start - d.ctx, d.win));
  const R = d.stft(slice(right, start - d.ctx, d.win));
  const x = d.magnitudes(L, R);
  const shape = [2, 1, SpleeterDsp.FRAMES, SpleeterDsp.BINS];
  const [voc, acc] = sessions;
  const tv = new ort.Tensor("float32", x, shape);
  const rv = await voc.run({ [voc.inputNames[0]]: tv });
  const ta = new ort.Tensor("float32", x, shape);
  const ra = await acc.run({ [acc.inputNames[0]]: ta });
  const v = rv[voc.outputNames[0]], a = ra[acc.outputNames[0]];
  const mask = d.mask(v.data as Float32Array, a.data as Float32Array);
  v.dispose?.();
  a.dispose?.();
  const ol = d.istft(L, mask, 0).slice(d.ctx, d.ctx + len);
  const or = d.istft(R, mask, 1).slice(d.ctx, d.ctx + len);
  return { left: ol, right: or };
}

async function segment(i: number) {
  if (!audio || !sessions.length) throw new Error("not ready");
  const r = model?.kind === "spleeter" ? await segmentSpleeter(i) : await segmentMdx(i);
  post({ type: "segment", index: i, left: r.left, right: r.right }, [r.left.buffer, r.right.buffer]);
}

const fail = (e: unknown) => post({ type: "error", message: e instanceof Error ? e.message : String(e) });

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "load") {
    model = msg.model;
    if (msg.model.kind === "mdx") mdx = new Mdx(msg.model);
    else spl = new SpleeterDsp();
    fetchModels(msg.urls)
      .then(createSessions)
      .then((s) => {
        sessions = s;
        maybeReady();
      })
      .catch(fail);
  } else if (msg.type === "audio") {
    audio = { left: msg.left, right: msg.right };
    maybeReady();
  } else if (msg.type === "segment") {
    queue = queue.then(() => segment(msg.index)).catch(fail);
  }
};
