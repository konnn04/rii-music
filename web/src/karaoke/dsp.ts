// DSP for MDX-Net separation: STFT / ISTFT with torch.stft conventions
// (center=True, reflect padding, periodic Hann window, onesided) and the
// model's tensor layout. Works for any n_fft = r·2^k with r ∈ {1, 3, 5}
// (6144 = 3·2048, 5120 = 5·1024).

import type { MdxParams } from "./models";

export const SAMPLE_RATE = 44100;

/** FFT of a fixed size n = r·2^k: r interleaved radix-2 FFTs combined with an r-point DFT. */
export class FFT {
  readonly n: number;
  private readonly r: number;
  private readonly m: number;
  private readonly bitRev: Uint32Array;
  private readonly cosM: Float64Array; // radix-2 twiddles for size m
  private readonly sinM: Float64Array;
  private readonly cosN: Float64Array; // W_n^x, x < n
  private readonly sinN: Float64Array;
  private readonly subRe: Float64Array[];
  private readonly subIm: Float64Array[];

  constructor(n: number) {
    let r = 1;
    for (const c of [5, 3]) if (n % c === 0) r = c;
    const m = n / r;
    if (!Number.isInteger(m) || (m & (m - 1)) !== 0) throw new Error(`FFT size ${n} is not r·2^k with r ∈ {1,3,5}`);
    this.n = n;
    this.r = r;
    this.m = m;
    const bits = Math.log2(m);
    this.bitRev = new Uint32Array(m);
    for (let i = 0; i < m; i++) {
      let x = i, y = 0;
      for (let b = 0; b < bits; b++) {
        y = (y << 1) | (x & 1);
        x >>= 1;
      }
      this.bitRev[i] = y;
    }
    this.cosM = new Float64Array(m >> 1);
    this.sinM = new Float64Array(m >> 1);
    for (let i = 0; i < m >> 1; i++) {
      this.cosM[i] = Math.cos((2 * Math.PI * i) / m);
      this.sinM[i] = -Math.sin((2 * Math.PI * i) / m);
    }
    this.cosN = new Float64Array(n);
    this.sinN = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.cosN[i] = Math.cos((2 * Math.PI * i) / n);
      this.sinN[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.subRe = Array.from({ length: r }, () => new Float64Array(m));
    this.subIm = Array.from({ length: r }, () => new Float64Array(m));
  }

  private radix2(re: Float64Array, im: Float64Array) {
    const m = this.m, br = this.bitRev;
    for (let i = 0; i < m; i++) {
      const j = br[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= m; size <<= 1) {
      const half = size >> 1, step = m / size;
      for (let start = 0; start < m; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cosM[k * step], wi = this.sinM[k * step];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /** In-place forward FFT. */
  fft(re: Float64Array, im: Float64Array): void {
    const { n, r, m } = this;
    for (let j = 0; j < r; j++) {
      const sr = this.subRe[j], si = this.subIm[j];
      for (let q = 0; q < m; q++) {
        sr[q] = re[q * r + j];
        si[q] = im[q * r + j];
      }
      this.radix2(sr, si);
    }
    if (r === 1) {
      re.set(this.subRe[0]);
      im.set(this.subIm[0]);
      return;
    }
    const tr = new Float64Array(r), ti = new Float64Array(r);
    for (let k = 0; k < m; k++) {
      // t_j = W_n^{jk} · Y_j[k]
      for (let j = 0; j < r; j++) {
        const yr = this.subRe[j][k], yi = this.subIm[j][k];
        const idx = (j * k) % n;
        const wr = this.cosN[idx], wi = this.sinN[idx];
        tr[j] = yr * wr - yi * wi;
        ti[j] = yr * wi + yi * wr;
      }
      // X[k + m·q] = Σ_j t_j · W_r^{jq}, and W_r^{x} = W_n^{x·m}
      for (let q = 0; q < r; q++) {
        let sr = 0, si = 0;
        for (let j = 0; j < r; j++) {
          const idx = (((j * q) % r) * m) % n;
          const wr = this.cosN[idx], wi = this.sinN[idx];
          sr += tr[j] * wr - ti[j] * wi;
          si += tr[j] * wi + ti[j] * wr;
        }
        re[k + m * q] = sr;
        im[k + m * q] = si;
      }
    }
  }

  /** In-place inverse FFT (scaled by 1/n). */
  ifft(re: Float64Array, im: Float64Array): void {
    for (let i = 0; i < this.n; i++) im[i] = -im[i];
    this.fft(re, im);
    const s = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= s;
      im[i] = -im[i] * s;
    }
  }
}

/** STFT / ISTFT and tensor packing for one model's parameters. */
export class Mdx {
  readonly p: MdxParams;
  /** Samples per model call (exactly dimT frames). */
  readonly chunk: number;
  /** Edge samples dropped from each chunk's output. */
  readonly trim: number;
  /** Useful samples per chunk. */
  readonly gen: number;
  private readonly fftr: FFT;
  private readonly win: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly plane: number;

  constructor(p: MdxParams) {
    this.p = p;
    this.chunk = p.hop * (p.dimT - 1);
    this.trim = p.nFft / 2;
    this.gen = this.chunk - 2 * this.trim;
    this.fftr = new FFT(p.nFft);
    this.win = new Float64Array(p.nFft);
    for (let i = 0; i < p.nFft; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / p.nFft);
    this.re = new Float64Array(p.nFft);
    this.im = new Float64Array(p.nFft);
    this.plane = p.dimF * p.dimT;
  }

  /** torch.stft(center=True, reflect) of one chunk → [dimF × dimT] re/im, index f*dimT + t. */
  stft(x: Float32Array): { re: Float32Array; im: Float32Array } {
    const { nFft, dimF, dimT, hop } = this.p;
    if (x.length !== this.chunk) throw new Error(`stft expects ${this.chunk} samples, got ${x.length}`);
    const half = nFft / 2, n = x.length;
    const outRe = new Float32Array(this.plane), outIm = new Float32Array(this.plane);
    const re = this.re, im = this.im, w = this.win;
    for (let t = 0; t < dimT; t++) {
      const start = t * hop - half; // in unpadded coordinates
      for (let i = 0; i < nFft; i++) {
        let j = start + i;
        if (j < 0) j = -j; // reflect (no edge repeat)
        else if (j >= n) j = 2 * (n - 1) - j;
        re[i] = x[j] * w[i];
        im[i] = 0;
      }
      this.fftr.fft(re, im);
      for (let f = 0; f < dimF; f++) {
        outRe[f * dimT + t] = re[f];
        outIm[f * dimT + t] = im[f];
      }
    }
    return { re: outRe, im: outIm };
  }

  /** Inverse of stft (bins ≥ dimF are zero) → chunk samples. */
  istft(specRe: Float32Array, specIm: Float32Array): Float32Array {
    const { nFft, dimF, dimT, hop } = this.p;
    const half = nFft / 2;
    const total = this.chunk + nFft;
    const acc = new Float64Array(total), norm = new Float64Array(total);
    const re = this.re, im = this.im, w = this.win;
    for (let t = 0; t < dimT; t++) {
      re.fill(0);
      im.fill(0);
      for (let f = 0; f < dimF; f++) {
        re[f] = specRe[f * dimT + t];
        im[f] = specIm[f * dimT + t];
      }
      im[0] = 0; // irfft ignores the DC (and Nyquist) imaginary part
      for (let f = 1; f < half; f++) {
        re[nFft - f] = re[f];
        im[nFft - f] = -im[f];
      }
      this.fftr.ifft(re, im);
      const off = t * hop;
      for (let i = 0; i < nFft; i++) {
        acc[off + i] += re[i] * w[i];
        norm[off + i] += w[i] * w[i];
      }
    }
    const out = new Float32Array(this.chunk);
    for (let i = 0; i < this.chunk; i++) {
      const k = i + half;
      out[i] = norm[k] > 1e-10 ? acc[k] / norm[k] : 0;
    }
    return out;
  }

  /** Model input [1, 4, dimF, dimT]: L re, L im, R re, R im; the lowest 3 bins zeroed. */
  pack(left: Float32Array, right: Float32Array): Float32Array {
    const { dimT } = this.p;
    const l = this.stft(left), r = this.stft(right);
    const t = new Float32Array(4 * this.plane);
    t.set(l.re, 0);
    t.set(l.im, this.plane);
    t.set(r.re, 2 * this.plane);
    t.set(r.im, 3 * this.plane);
    for (let c = 0; c < 4; c++) t.fill(0, c * this.plane, c * this.plane + 3 * dimT);
    return t;
  }

  /** Model output (same layout) → left / right chunk samples. */
  unpack(t: Float32Array): { left: Float32Array; right: Float32Array } {
    const P = this.plane;
    return {
      left: this.istft(t.subarray(0, P), t.subarray(P, 2 * P)),
      right: this.istft(t.subarray(2 * P, 3 * P), t.subarray(3 * P, 4 * P)),
    };
  }
}
