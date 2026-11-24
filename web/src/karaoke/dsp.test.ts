// Plain self-test for dsp.ts (no test framework required).
import { CHUNK, DIM_F, DIM_T, N_FFT, TRIM, fft, ifft, istft, packTensor, stft } from "./dsp";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs DSP verification checks and returns failure messages (empty = ok). */
export function selfTest(): string[] {
  const failures: string[] = [];
  const rand = mulberry32(0x5269694d);

  // 1. FFT vs naive DFT on random n=6144 complex data (max error < 1e-3).
  const inRe = new Float32Array(N_FFT);
  const inIm = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) {
    inRe[n] = rand() * 2 - 1;
    inIm[n] = rand() * 2 - 1;
  }
  const gotRe = new Float32Array(inRe);
  const gotIm = new Float32Array(inIm);
  fft(gotRe, gotIm);

  let maxFftErr = 0;
  for (let k = 0; k < N_FFT; k++) {
    const stepAngle = (-2 * Math.PI * k) / N_FFT;
    const wr = Math.cos(stepAngle);
    const wi = Math.sin(stepAngle);
    let curR = 1;
    let curI = 0;
    let sumR = 0;
    let sumI = 0;
    for (let n = 0; n < N_FFT; n++) {
      // Refresh recurrence every 256 steps to prevent float drift.
      if ((n & 255) === 0 && n > 0) {
        const a = stepAngle * n;
        curR = Math.cos(a);
        curI = Math.sin(a);
      }
      const xr = inRe[n];
      const xi = inIm[n];
      sumR += xr * curR - xi * curI;
      sumI += xr * curI + xi * curR;
      const nextR = curR * wr - curI * wi;
      const nextI = curR * wi + curI * wr;
      curR = nextR;
      curI = nextI;
    }
    const errR = Math.abs(gotRe[k] - sumR);
    const errI = Math.abs(gotIm[k] - sumI);
    if (errR > maxFftErr) maxFftErr = errR;
    if (errI > maxFftErr) maxFftErr = errI;
  }
  if (maxFftErr >= 1e-3) {
    failures.push(`fft vs naive DFT max error ${maxFftErr.toExponential(3)} >= 1e-3`);
  }

  // 2. IFFT(FFT(x)) round-trip check.
  ifft(gotRe, gotIm);
  let maxIfftErr = 0;
  for (let n = 0; n < N_FFT; n++) {
    const errR = Math.abs(gotRe[n] - inRe[n]);
    const errI = Math.abs(gotIm[n] - inIm[n]);
    if (errR > maxIfftErr) maxIfftErr = errR;
    if (errI > maxIfftErr) maxIfftErr = errI;
  }
  if (maxIfftErr >= 1e-4) {
    failures.push(`ifft(fft(x)) max error ${maxIfftErr.toExponential(3)} >= 1e-4`);
  }

  // 3. STFT -> ISTFT round-trip on a random signal (max error < 1e-4 away from edges).
  // Apply a 3-tap [0.25, 0.5, 0.25] filter so Nyquist bin (dropped by DIM_F) has zero energy.
  const raw = new Float32Array(CHUNK + 2);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = rand() * 2 - 1;
  }
  const sig = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) {
    sig[i] = 0.25 * raw[i] + 0.5 * raw[i + 1] + 0.25 * raw[i + 2];
  }
  const spec = stft(sig);
  const rec = istft(spec.re, spec.im);
  let maxStftErr = 0;
  for (let i = TRIM; i < CHUNK - TRIM; i++) {
    const err = Math.abs(rec[i] - sig[i]);
    if (err > maxStftErr) maxStftErr = err;
  }
  if (maxStftErr >= 1e-4) {
    failures.push(`stft->istft max error ${maxStftErr.toExponential(3)} >= 1e-4`);
  }

  // 4. Tensor packing zeroes bins f < 3.
  const tensor = packTensor(sig, sig);
  if (tensor.length !== 4 * DIM_F * DIM_T) {
    failures.push(`packTensor length ${tensor.length} != ${4 * DIM_F * DIM_T}`);
  } else {
    let nonZeroLow = false;
    for (let c = 0; c < 4 && !nonZeroLow; c++) {
      for (let f = 0; f < 3 && !nonZeroLow; f++) {
        for (let t = 0; t < DIM_T; t++) {
          if (tensor[(c * DIM_F + f) * DIM_T + t] !== 0) {
            nonZeroLow = true;
            break;
          }
        }
      }
    }
    if (nonZeroLow) {
      failures.push("packTensor did not zero frequency bins f < 3");
    }
  }

  return failures;
}
