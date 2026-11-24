// Module Web Worker for MDX-Net ONNX instrumental separation.
import * as ort from "onnxruntime-web/webgpu";
import { CHUNK, COMPENSATE, DIM_F, DIM_T, GEN, TRIM, packTensor, unpackTensor } from "./dsp";

export type WorkerIn =
  | { type: "run"; modelUrl: string; left: Float32Array; right: Float32Array }
  | { type: "cancel" };

export type WorkerOut =
  | { type: "progress"; phase: "model" | "separate"; progress: number }
  | { type: "backend"; name: string }
  | { type: "done"; left: Float32Array; right: Float32Array }
  | { type: "error"; message: string };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerIn>) => void) | null;
  postMessage(message: WorkerOut, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;
const MODEL_CACHE = "rii-karaoke-model";

let cachedSession: ort.InferenceSession | null = null;
let cachedModelUrl: string | null = null;
let cancelled = false;

function postProgress(phase: "model" | "separate", progress: number): void {
  ctx.postMessage({ type: "progress", phase, progress: Math.max(0, Math.min(1, progress)) });
}

async function fetchModelBytes(modelUrl: string): Promise<Uint8Array<ArrayBuffer>> {
  const cache = typeof caches !== "undefined" ? await caches.open(MODEL_CACHE) : null;
  if (cache) {
    const hit = await cache.match(modelUrl);
    if (hit) {
      const buf = await hit.arrayBuffer();
      postProgress("model", 1);
      return new Uint8Array(buf);
    }
  }

  postProgress("model", 0);
  const res = await fetch(modelUrl, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Model download failed: HTTP ${res.status}`);
  }

  const total = Number(res.headers.get("Content-Length") || 0);
  let bytes: Uint8Array<ArrayBuffer>;

  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      if (cancelled) {
        await reader.cancel().catch(() => {});
        return new Uint8Array(0);
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        if (total > 0) {
          postProgress("model", loaded / total);
        }
      }
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }

  postProgress("model", 1);

  if (cache && !cancelled && bytes.byteLength > 0) {
    try {
      await cache.put(
        modelUrl,
        new Response(bytes, {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      );
    } catch {
      // Ignore cache quota errors; separation can still proceed.
    }
  }

  return bytes;
}

/** The WebGPU adapter's name as far as the browser tells it. */
function gpuName(): string {
  const dev = ort.env.webgpu.device as { adapterInfo?: { vendor?: string; architecture?: string; description?: string } } | undefined;
  const i = dev?.adapterInfo;
  const name = i?.description || [i?.vendor, i?.architecture].filter(Boolean).join(" ");
  return name ? `GPU · ${name}` : "GPU";
}

async function getSession(modelUrl: string): Promise<ort.InferenceSession | null> {
  if (cachedSession && cachedModelUrl === modelUrl) {
    postProgress("model", 1);
    return cachedSession;
  }

  const bytes = await fetchModelBytes(modelUrl);
  if (cancelled) return null;

  let session: ort.InferenceSession;
  let backend = "cpu";
  try {
    // Laptops with two GPUs: ask for the discrete one (the browser may still pick the
    // integrated one, e.g. when Windows' graphics setting says "power saving").
    ort.env.webgpu.powerPreference = "high-performance";
    session = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] });
    backend = gpuName();
  } catch {
    session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  }
  ctx.postMessage({ type: "backend", name: backend });

  cachedSession = session;
  cachedModelUrl = modelUrl;
  return session;
}

async function runSeparation(modelUrl: string, left: Float32Array, right: Float32Array): Promise<void> {
  cancelled = false;
  const session = await getSession(modelUrl);
  if (!session || cancelled) return;

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const n = Math.min(left.length, right.length);
  const pad = GEN - (n % GEN);
  const paddedLen = TRIM + n + pad + TRIM;

  const padL = new Float32Array(paddedLen);
  const padR = new Float32Array(paddedLen);
  padL.set(left.subarray(0, n), TRIM);
  padR.set(right.subarray(0, n), TRIM);

  const outL = new Float32Array(n);
  const outR = new Float32Array(n);

  const limit = paddedLen - 2 * TRIM;
  const totalChunks = Math.max(1, Math.ceil(limit / GEN));
  postProgress("separate", 0);

  for (let i = 0, chunkIdx = 0; i < limit; i += GEN, chunkIdx++) {
    if (cancelled) return;

    const chunkL = padL.subarray(i, i + CHUNK);
    const chunkR = padR.subarray(i, i + CHUNK);
    const inputData = packTensor(chunkL, chunkR);
    const inputTensor = new ort.Tensor("float32", inputData, [1, 4, DIM_F, DIM_T]);

    let results: ort.InferenceSession.OnnxValueMapType;
    try {
      results = await session.run({ [inputName]: inputTensor });
    } finally {
      inputTensor.dispose?.();
    }

    const outputTensor = results[outputName];
    const outData = outputTensor.data as Float32Array;
    const { left: sepL, right: sepR } = unpackTensor(outData);
    outputTensor.dispose?.();

    const copyLen = Math.min(GEN, n - i);
    for (let k = 0; k < copyLen; k++) {
      outL[i + k] = sepL[TRIM + k] * COMPENSATE;
      outR[i + k] = sepR[TRIM + k] * COMPENSATE;
    }

    postProgress("separate", (chunkIdx + 1) / totalChunks);
  }

  if (cancelled) return;
  ctx.postMessage({ type: "done", left: outL, right: outR }, [outL.buffer, outR.buffer]);
}

ctx.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  if (msg.type === "run") {
    runSeparation(msg.modelUrl, msg.left, msg.right).catch((err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      ctx.postMessage({ type: "error", message });
    });
  }
};
