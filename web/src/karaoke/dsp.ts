// Pure DSP routines for UVR-MDX-NET-Inst_HQ_3 (no DOM dependencies).

export const SAMPLE_RATE = 44100;
export const N_FFT = 6144; // 3 * 2048
export const HOP = 1024;
export const DIM_F = 3072; // N_FFT / 2
export const DIM_T = 256;
export const COMPENSATE = 1.022;
export const CHUNK = HOP * (DIM_T - 1); // 261120 samples -> exactly 256 frames
export const TRIM = N_FFT / 2; // 3072
export const GEN = CHUNK - 2 * TRIM; // 254976

const M = 2048; // N_FFT / 3 = 2^11
const LOG2_M = 11;
const SQRT3_2 = Math.sqrt(3) / 2;
const PLANE = DIM_F * DIM_T;

// Precomputed bit-reversal and twiddle tables for 2048-point radix-2 FFT.
const bitRev = new Uint16Array(M);
const rad2Cos = new Float64Array(M >> 1);
const rad2Sin = new Float64Array(M >> 1);

// Precomputed twiddle tables for the radix-3 combine stage (W_N^q and W_N^{2q}).
const tw1Cos = new Float64Array(M);
const tw1Sin = new Float64Array(M);
const tw2Cos = new Float64Array(M);
const tw2Sin = new Float64Array(M);

// Periodic Hann window of length N_FFT.
const hann = new Float64Array(N_FFT);

for (let i = 0; i < M; i++) {
  let x = i;
  let r = 0;
  for (let b = 0; b < LOG2_M; b++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  bitRev[i] = r;

  const a1 = (-2 * Math.PI * i) / N_FFT;
  tw1Cos[i] = Math.cos(a1);
  tw1Sin[i] = Math.sin(a1);

  const a2 = (-4 * Math.PI * i) / N_FFT;
  tw2Cos[i] = Math.cos(a2);
  tw2Sin[i] = Math.sin(a2);
}

for (let j = 0; j < M >> 1; j++) {
  const a = (-2 * Math.PI * j) / M;
  rad2Cos[j] = Math.cos(a);
  rad2Sin[j] = Math.sin(a);
}

for (let n = 0; n < N_FFT; n++) {
  hann[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / N_FFT));
}

// Reusable scratch buffers for FFT sub-transforms and frame processing.
const r0 = new Float64Array(M);
const i0 = new Float64Array(M);
const r1 = new Float64Array(M);
const i1 = new Float64Array(M);
const r2 = new Float64Array(M);
const i2 = new Float64Array(M);

const frameRe = new Float32Array(N_FFT);
const frameIm = new Float32Array(N_FFT);

function fft2048(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < M; i++) {
    const j = bitRev[i];
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let half = 1; half < M; half <<= 1) {
    const len = half << 1;
    const step = M / len;
    for (let i = 0; i < M; i += len) {
      for (let j = 0; j < half; j++) {
        const tw = j * step;
        const wr = rad2Cos[tw];
        const wi = rad2Sin[tw];
        const u = i + j;
        const v = u + half;
        const tr = wr * re[v] - wi * im[v];
        const ti = wr * im[v] + wi * re[v];
        re[v] = re[u] - tr;
        im[v] = im[u] - ti;
        re[u] += tr;
        im[u] += ti;
      }
    }
  }
}

/** In-place 6144-point mixed-radix (3 * 2048) forward FFT. */
export function fft(re: Float32Array, im: Float32Array): void {
  for (let m = 0; m < M; m++) {
    const idx = m * 3;
    r0[m] = re[idx];
    i0[m] = im[idx];
    r1[m] = re[idx + 1];
    i1[m] = im[idx + 1];
    r2[m] = re[idx + 2];
    i2[m] = im[idx + 2];
  }

  fft2048(r0, i0);
  fft2048(r1, i1);
  fft2048(r2, i2);

  for (let q = 0; q < M; q++) {
    const ar = r0[q];
    const ai = i0[q];

    const w1r = tw1Cos[q];
    const w1i = tw1Sin[q];
    const br = w1r * r1[q] - w1i * i1[q];
    const bi = w1r * i1[q] + w1i * r1[q];

    const w2r = tw2Cos[q];
    const w2i = tw2Sin[q];
    const cr = w2r * r2[q] - w2i * i2[q];
    const ci = w2r * i2[q] + w2i * r2[q];

    const sumBCr = br + cr;
    const sumBCi = bi + ci;
    const diffBCr = br - cr;
    const diffBCi = bi - ci;

    re[q] = ar + sumBCr;
    im[q] = ai + sumBCi;

    const midR = ar - 0.5 * sumBCr;
    const midI = ai - 0.5 * sumBCi;
    const rotR = SQRT3_2 * diffBCi;
    const rotI = SQRT3_2 * diffBCr;

    re[q + M] = midR + rotR;
    im[q + M] = midI - rotI;

    re[q + 2 * M] = midR - rotR;
    im[q + 2 * M] = midI + rotI;
  }
}

/** In-place 6144-point inverse FFT using the conjugate trick. */
export function ifft(re: Float32Array, im: Float32Array): void {
  for (let k = 0; k < N_FFT; k++) {
    im[k] = -im[k];
  }
  fft(re, im);
  const invN = 1 / N_FFT;
  for (let k = 0; k < N_FFT; k++) {
    re[k] *= invN;
    im[k] = -im[k] * invN;
  }
}

/**
 * STFT matching torch.stft(center=True, pad_mode="reflect", onesided=True)
 * with periodic Hann window, keeping the first DIM_F bins.
 * Output layout: [DIM_F, DIM_T] with index f * DIM_T + t.
 */
export function stft(x: Float32Array): { re: Float32Array; im: Float32Array } {
  if (x.length !== CHUNK) {
    throw new Error(`stft expects length ${CHUNK}, got ${x.length}`);
  }
  const pad = TRIM;
  const padded = new Float32Array(CHUNK + 2 * pad);

  // Reflect padding (does not repeat edge sample).
  for (let i = 0; i < pad; i++) {
    padded[i] = x[pad - i];
  }
  padded.set(x, pad);
  for (let i = 0; i < pad; i++) {
    padded[pad + CHUNK + i] = x[CHUNK - 2 - i];
  }

  const outRe = new Float32Array(PLANE);
  const outIm = new Float32Array(PLANE);

  for (let t = 0; t < DIM_T; t++) {
    const offset = t * HOP;
    for (let n = 0; n < N_FFT; n++) {
      frameRe[n] = padded[offset + n] * hann[n];
      frameIm[n] = 0;
    }
    fft(frameRe, frameIm);
    for (let f = 0; f < DIM_F; f++) {
      const idx = f * DIM_T + t;
      outRe[idx] = frameRe[f];
      outIm[idx] = frameIm[f];
    }
  }

  return { re: outRe, im: outIm };
}

/**
 * Inverse STFT with overlap-add and squared-window normalization.
 * Expects re/im of layout [DIM_F, DIM_T] (index f * DIM_T + t); bins >= DIM_F are zero.
 */
export function istft(re: Float32Array, im: Float32Array): Float32Array {
  const pad = TRIM;
  const totalLen = CHUNK + 2 * pad;
  const out = new Float64Array(totalLen);
  const winSum = new Float64Array(totalLen);

  for (let t = 0; t < DIM_T; t++) {
    frameRe[0] = re[t];
    frameIm[0] = im[t];
    for (let f = 1; f < DIM_F; f++) {
      const idx = f * DIM_T + t;
      const r = re[idx];
      const j = im[idx];
      frameRe[f] = r;
      frameIm[f] = j;
      frameRe[N_FFT - f] = r;
      frameIm[N_FFT - f] = -j;
    }
    // Bins DIM_F..N_FFT/2 (Nyquist at index 3072) are zero.
    frameRe[DIM_F] = 0;
    frameIm[DIM_F] = 0;

    ifft(frameRe, frameIm);

    const offset = t * HOP;
    for (let n = 0; n < N_FFT; n++) {
      const w = hann[n];
      out[offset + n] += frameRe[n] * w;
      winSum[offset + n] += w * w;
    }
  }

  const result = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) {
    const ws = winSum[pad + i];
    result[i] = ws > 1e-8 ? out[pad + i] / ws : 0;
  }
  return result;
}

/**
 * Packs stereo CHUNK audio into model input tensor [1, 4, DIM_F, DIM_T]
 * with channel order [L_re, L_im, R_re, R_im] and bins f < 3 zeroed.
 */
export function packTensor(left: Float32Array, right: Float32Array): Float32Array {
  const l = stft(left);
  const r = stft(right);
  const tensor = new Float32Array(4 * PLANE);

  tensor.set(l.re, 0);
  tensor.set(l.im, PLANE);
  tensor.set(r.re, 2 * PLANE);
  tensor.set(r.im, 3 * PLANE);

  // Zero the first 3 frequency bins (f < 3) across all 4 channels.
  for (let c = 0; c < 4; c++) {
    const base = c * PLANE;
    tensor.fill(0, base, base + 3 * DIM_T);
  }

  return tensor;
}

/** Unpacks model output tensor [1, 4, DIM_F, DIM_T] back to stereo CHUNK audio. */
export function unpackTensor(tensor: Float32Array): { left: Float32Array; right: Float32Array } {
  const lRe = tensor.subarray(0, PLANE);
  const lIm = tensor.subarray(PLANE, 2 * PLANE);
  const rRe = tensor.subarray(2 * PLANE, 3 * PLANE);
  const rIm = tensor.subarray(3 * PLANE, 4 * PLANE);
  return {
    left: istft(lRe, lIm),
    right: istft(rRe, rIm),
  };
}
