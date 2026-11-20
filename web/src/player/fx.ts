// Sound settings, processed in the listener's browser (Web Audio): nothing runs
// on the server.
//
//   master → 10-band EQ → (+ exciter) → bass → crossfeed → width → limiter → out
//
// - EQ: peaking filters at ISO octave centres, with a pre-gain so boosts don't clip.
// - Exciter: regenerates upper harmonics of the 3.5 kHz+ band (the idea behind
//   "high-frequency restoration" on music players, e.g. Sony DSEE, which is
//   closed source; this is the classic open aural-exciter technique). It can't
//   bring back what lossy compression removed, but it brightens dull files.
// - Crossfeed: headphones only; mixes a low-passed, slightly delayed bit of each
//   channel into the other like speakers in a room (after Bauer / bs2b).
// - Width: mid/side stereo widening (1 = unchanged).
// - Limiter: a fast compressor at −1 dBFS so boosts never distort.
// Settings are per device (headphones here, speakers there), kept in localStorage.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_PRESETS: Record<string, number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  pop: [-1, 1, 3, 4, 2, 0, -1, -1, 1, 2],
  rock: [4, 3, 1, -1, -2, -1, 1, 3, 4, 4],
  acoustic: [3, 2, 1, 1, 2, 2, 3, 3, 2, 1],
  electronic: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  night: [4, 3, 1, 0, -1, -1, 0, 1, 3, 3], // loudness curve for low volume
};

export type FxState = {
  enabled: boolean;
  preset: string; // a key of EQ_PRESETS or "custom"
  eq: number[]; // dB per band, −12…12
  bass: number; // 0…1 → 0…+9 dB low shelf
  exciter: number; // 0…1
  crossfeed: number; // 0 (off)…1
  width: number; // 0.5…1.6, 1 = unchanged
  limiter: boolean;
};

export const FX_DEFAULT: FxState = { enabled: false, preset: "flat", eq: EQ_PRESETS.flat, bass: 0, exciter: 0, crossfeed: 0, width: 1, limiter: true };

export const useFx = create<FxState & { set: (p: Partial<FxState>) => void; reset: () => void }>()(
  persist(
    (set) => ({
      ...FX_DEFAULT,
      set: (p) => set(p),
      reset: () => set(FX_DEFAULT),
    }),
    { name: "rii-fx", partialize: ({ set: _s, reset: _r, ...rest }) => rest },
  ),
);

/** The processing graph between the player's master gain and the speakers. */
export class FxChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private pre: GainNode;
  private eq: BiquadFilterNode[];
  private exHP: BiquadFilterNode;
  private exShape: WaveShaperNode;
  private exHP2: BiquadFilterNode;
  private exGain: GainNode;
  private sum: GainNode;
  private bass: BiquadFilterNode;
  private cf: { split: ChannelSplitterNode; merge: ChannelMergerNode; direct: GainNode[]; cross: GainNode[]; lp: BiquadFilterNode[]; delay: DelayNode[] };
  private wd: { split: ChannelSplitterNode; merge: ChannelMergerNode; g: GainNode[] };
  private limiter: DynamicsCompressorNode;
  private wired = false;
  private init = false;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.pre = ctx.createGain();
    this.eq = EQ_BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
      b.frequency.value = f;
      b.Q.value = 1.1;
      return b;
    });
    for (let i = 0; i < this.eq.length - 1; i++) this.eq[i].connect(this.eq[i + 1]);

    this.exHP = ctx.createBiquadFilter();
    this.exHP.type = "highpass";
    this.exHP.frequency.value = 3500;
    this.exShape = ctx.createWaveShaper();
    this.exShape.curve = harmonicCurve();
    this.exShape.oversample = "2x";
    this.exHP2 = ctx.createBiquadFilter();
    this.exHP2.type = "highpass";
    this.exHP2.frequency.value = 5000;
    this.exGain = ctx.createGain();
    this.sum = ctx.createGain();
    this.exHP.connect(this.exShape).connect(this.exHP2).connect(this.exGain).connect(this.sum);

    this.bass = ctx.createBiquadFilter();
    this.bass.type = "lowshelf";
    this.bass.frequency.value = 90;

    // crossfeed: L' = L + k·LP(R) delayed, R' = R + k·LP(L) delayed
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const direct = [ctx.createGain(), ctx.createGain()];
    const cross = [ctx.createGain(), ctx.createGain()];
    const lp = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    const delay = [ctx.createDelay(0.01), ctx.createDelay(0.01)];
    for (let c = 0; c < 2; c++) {
      split.connect(direct[c], c).connect(merge, 0, c);
      lp[c].type = "lowpass";
      lp[c].frequency.value = 700;
      delay[c].delayTime.value = 0.0003;
      split.connect(lp[c], c);
      lp[c].connect(delay[c]).connect(cross[c]).connect(merge, 0, 1 - c);
    }
    this.cf = { split, merge, direct, cross, lp, delay };

    // width: L' = a·L + b·R, R' = a·R + b·L with a = (1+w)/2, b = (1−w)/2
    const wsplit = ctx.createChannelSplitter(2);
    const wmerge = ctx.createChannelMerger(2);
    const g = [ctx.createGain(), ctx.createGain(), ctx.createGain(), ctx.createGain()]; // LL, RL, RR, LR
    wsplit.connect(g[0], 0).connect(wmerge, 0, 0);
    wsplit.connect(g[1], 1).connect(wmerge, 0, 0);
    wsplit.connect(g[2], 1).connect(wmerge, 0, 1);
    wsplit.connect(g[3], 0).connect(wmerge, 0, 1);
    this.wd = { split: wsplit, merge: wmerge, g };

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    this.apply(useFx.getState());
    useFx.subscribe((s) => this.apply(s));
  }

  /** Route through the effects, or straight through when they are off (no CPU cost). */
  private wire(on: boolean) {
    // Only the links between stages change; each stage keeps its inner wiring.
    for (const n of [this.input, this.pre, this.eq[this.eq.length - 1], this.sum, this.bass, this.cf.merge, this.wd.merge, this.limiter]) n.disconnect();
    this.wired = on;
    if (!on) {
      this.input.connect(this.output);
      return;
    }
    this.input.connect(this.pre).connect(this.eq[0]);
    const eqOut = this.eq[this.eq.length - 1];
    eqOut.connect(this.sum);
    eqOut.connect(this.exHP);
    this.sum.connect(this.bass).connect(this.cf.split);
    this.cf.merge.connect(this.wd.split);
    this.wd.merge.connect(this.limiter).connect(this.output);
  }

  apply(s: FxState) {
    const on = s.enabled;
    if (!this.init || on !== this.wired) {
      this.init = true;
      this.wire(on);
    }
    if (!on) return;
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.03);
    const maxBoost = Math.max(0, ...s.eq, s.bass * 9);
    set(this.pre.gain, Math.pow(10, -(maxBoost * 0.5) / 20));
    this.eq.forEach((b, i) => set(b.gain, clamp(s.eq[i] ?? 0, -12, 12)));
    set(this.bass.gain, clamp(s.bass, 0, 1) * 9);
    set(this.exGain.gain, clamp(s.exciter, 0, 1) * 0.35);
    const k = clamp(s.crossfeed, 0, 1) * 0.35;
    this.cf.cross.forEach((g) => set(g.gain, k));
    this.cf.direct.forEach((g) => set(g.gain, 1 - k * 0.5));
    const w = clamp(s.width, 0.5, 1.6);
    const a = (1 + w) / 2, b = (1 - w) / 2;
    set(this.wd.g[0].gain, a);
    set(this.wd.g[2].gain, a);
    set(this.wd.g[1].gain, b);
    set(this.wd.g[3].gain, b);
    // Limiter "off" = a transparent compressor setting.
    set(this.limiter.threshold, s.limiter ? -1 : 0);
    set(this.limiter.ratio, s.limiter ? 20 : 1);
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));
}

/** Soft asymmetric saturation: adds even and odd harmonics to the high band. */
function harmonicCurve() {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(2.5 * x) * 0.8 + 0.2 * x * x;
  }
  return c;
}
