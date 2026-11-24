// Wrapper around the "rii-kstream" AudioWorkletNode for streaming AI instrumentals.
import { SAMPLE_RATE } from "./dsp";

const loaded = new WeakMap<AudioContext, Promise<void>>();

export type GapCallback = (gap: boolean, time?: number) => void;

type WorkletOut = { type: "gap"; time: number } | { type: "covered" };

export class KaraokeStream {
  private ctx: AudioContext;
  private node: AudioWorkletNode;
  private gain: GainNode;
  private segLen = 0;
  private count = 0;
  private total = 0;
  private srcRate = SAMPLE_RATE;
  private bitmap = new Uint8Array(0);
  private gapListeners = new Set<GapCallback>();
  private disposed = false;

  private constructor(ctx: AudioContext, node: AudioWorkletNode, gain: GainNode) {
    this.ctx = ctx;
    this.node = node;
    this.gain = gain;

    this.node.port.onmessage = (ev: MessageEvent<WorkletOut>) => {
      if (this.disposed) return;
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "gap") {
        for (const cb of this.gapListeners) cb(true, msg.time);
      } else if (msg.type === "covered") {
        for (const cb of this.gapListeners) cb(false);
      }
    };
  }

  static async create(ctx: AudioContext, dest: AudioNode): Promise<KaraokeStream> {
    if (!ctx.audioWorklet) {
      throw new Error("AudioWorklet unavailable");
    }
    let p = loaded.get(ctx);
    if (!p) {
      p = ctx.audioWorklet.addModule("/karaoke-stream.js");
      loaded.set(ctx, p);
    }
    try {
      await p;
    } catch (err) {
      loaded.delete(ctx);
      throw err;
    }

    const node = new AudioWorkletNode(ctx, "rii-kstream", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    const gain = ctx.createGain();
    gain.gain.value = 1;
    node.connect(gain);
    gain.connect(dest);
    return new KaraokeStream(ctx, node, gain);
  }

  init(segLen: number, count: number, total: number, srcRate = SAMPLE_RATE): void {
    if (this.disposed) return;
    this.segLen = segLen;
    this.count = count;
    this.total = total;
    this.srcRate = srcRate;
    this.bitmap = new Uint8Array(Math.max(0, count));
    this.node.port.postMessage({ type: "init", segLen, count, total, srcRate });
  }

  add(index: number, left: Float32Array, right: Float32Array): void {
    if (this.disposed) return;
    if (index >= 0 && index < this.bitmap.length) {
      this.bitmap[index] = 1;
    }
    const l = new Float32Array(left);
    const r = new Float32Array(right);
    this.node.port.postMessage({ type: "seg", index, left: l, right: r }, [l.buffer, r.buffer]);
  }

  sync(el: HTMLMediaElement): void {
    if (this.disposed) return;
    const time = Number.isFinite(el.currentTime) ? el.currentTime : 0;
    const playing = !el.paused && !el.ended;
    const at = this.ctx.currentTime;
    const rate = Number.isFinite(el.playbackRate) && el.playbackRate > 0 ? el.playbackRate : 1;
    this.node.port.postMessage({ type: "sync", time, playing, at, rate });
  }

  covers(time: number): boolean {
    if (this.disposed || this.segLen <= 0 || this.count <= 0 || this.total <= 0) return false;
    if (!Number.isFinite(time) || time < 0) return false;
    const sample = Math.floor(time * this.srcRate);
    const seg = sample >= this.total ? this.count - 1 : Math.floor(sample / this.segLen);
    return seg >= 0 && seg < this.bitmap.length && this.bitmap[seg] === 1;
  }

  onGap(cb: GapCallback): () => void {
    this.gapListeners.add(cb);
    return () => {
      this.gapListeners.delete(cb);
    };
  }

  dispose(fadeSec = 0): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gapListeners.clear();
    this.node.port.onmessage = null;

    const finish = () => {
      try {
        this.node.port.postMessage({ type: "stop" });
      } catch {
        /* ignore */
      }
      try {
        this.node.disconnect();
        this.gain.disconnect();
      } catch {
        /* ignore */
      }
    };

    if (fadeSec > 0 && this.ctx.state === "running") {
      const now = this.ctx.currentTime;
      const g = this.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fadeSec);
      window.setTimeout(finish, Math.ceil(fadeSec * 1000) + 20);
    } else {
      finish();
    }
  }
}
