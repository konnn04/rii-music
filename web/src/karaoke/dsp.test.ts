// Plain self-test for dsp.ts (no test framework): run with any TS runner and
// check that selfTest() returns no failures.
import { FFT, Mdx } from "./dsp";
import { MODELS } from "./models";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns failure messages (empty = ok). */
export function selfTest(): string[] {
  const fail: string[] = [];
  const rand = rng(0x5269694d);

  // FFT vs a naive DFT for every size the models use (and a small one per radix).
  for (const n of [12, 20, 16, 5120, 6144]) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = rand() * 2 - 1;
      im[i] = rand() * 2 - 1;
    }
    const gr = re.slice(), gi = im.slice();
    const f = new FFT(n);
    f.fft(gr, gi);
    let err = 0;
    for (let k = 0; k < n; k += n > 64 ? 97 : 1) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
        si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
      }
      err = Math.max(err, Math.abs(sr - gr[k]), Math.abs(si - gi[k]));
    }
    if (err > 1e-6) fail.push(`fft n=${n}: max error ${err}`);
    f.ifft(gr, gi);
    let back = 0;
    for (let i = 0; i < n; i++) back = Math.max(back, Math.abs(gr[i] - re[i]), Math.abs(gi[i] - im[i]));
    if (back > 1e-9) fail.push(`ifft n=${n}: round trip error ${back}`);
  }

  // STFT → ISTFT round trip of a band-limited signal (all energy below dimF).
  for (const m of Object.values(MODELS)) {
    const d = new Mdx(m);
    const x = new Float32Array(d.chunk);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(i * 0.031) + 0.3 * Math.sin(i * 0.47 + 1);
    const s = d.stft(x);
    const y = d.istft(s.re, s.im);
    let err = 0;
    for (let i = d.trim; i < x.length - d.trim; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    if (err > 1e-4) fail.push(`stft/istft ${m.id}: max error ${err}`);
  }
  return fail;
}
