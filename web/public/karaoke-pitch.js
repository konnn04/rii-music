// AudioWorkletProcessor: two-tap granular pitch shifter per channel.
// Delay line ~100 ms, 50 ms sin^2 crossfaded window, pass-through at ratio 1.

class RiiPitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "semitones",
        defaultValue: 0,
        minValue: -12,
        maxValue: 12,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this._winLen = Math.max(64, Math.round(sampleRate * 0.05));
    this._bufLen = Math.max(this._winLen * 2, Math.round(sampleRate * 0.1));
    this._bufs = [new Float32Array(this._bufLen), new Float32Array(this._bufLen)];
    this._writeIdx = 0;
    this._phase = 0;
    this._portSemitones = null;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.semitones === "number" && Number.isFinite(e.data.semitones)) {
        this._portSemitones = e.data.semitones;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const input = inputs[0];
    const outCh = output.length;

    if (!input || input.length === 0) {
      for (let ch = 0; ch < outCh; ch++) output[ch].fill(0);
      return true;
    }

    const semi =
      this._portSemitones !== null
        ? this._portSemitones
        : parameters.semitones
          ? parameters.semitones[0]
          : 0;

    // Ratio 1: pass through untouched.
    if (Math.abs(semi) < 1e-6) {
      for (let ch = 0; ch < outCh; ch++) {
        const src = input[ch] || input[0];
        if (src) output[ch].set(src);
        else output[ch].fill(0);
      }
      return true;
    }

    while (this._bufs.length < outCh) {
      this._bufs.push(new Float32Array(this._bufLen));
    }

    const ratio = Math.pow(2, semi / 12);
    const winLen = this._winLen;
    const bufLen = this._bufLen;
    const phaseStep = (1 - ratio) / winLen;
    const frames = output[0].length;
    let w = this._writeIdx;
    let p = this._phase;

    for (let i = 0; i < frames; i++) {
      const p1 = p;
      const p2 = p1 < 0.5 ? p1 + 0.5 : p1 - 0.5;
      const s1 = Math.sin(Math.PI * p1);
      const w1 = s1 * s1;
      const w2 = 1 - w1;

      // 1-sample floor keeps linear interpolation behind the write head.
      let r1 = w - (1 + p1 * winLen);
      if (r1 < 0) r1 += bufLen;
      const i10 = r1 | 0;
      const f1 = r1 - i10;
      const i11 = i10 + 1 < bufLen ? i10 + 1 : 0;

      let r2 = w - (1 + p2 * winLen);
      if (r2 < 0) r2 += bufLen;
      const i20 = r2 | 0;
      const f2 = r2 - i20;
      const i21 = i20 + 1 < bufLen ? i20 + 1 : 0;

      for (let ch = 0; ch < outCh; ch++) {
        const src = input[ch] || input[0];
        const buf = this._bufs[ch];
        buf[w] = src ? src[i] : 0;
        const v1 = buf[i10] + f1 * (buf[i11] - buf[i10]);
        const v2 = buf[i20] + f2 * (buf[i21] - buf[i20]);
        output[ch][i] = v1 * w1 + v2 * w2;
      }

      w = w + 1 < bufLen ? w + 1 : 0;
      p += phaseStep;
      if (p >= 1) p -= Math.floor(p);
      else if (p < 0) p -= Math.floor(p);
    }

    this._writeIdx = w;
    this._phase = p;
    return true;
  }
}

registerProcessor("rii-pitch", RiiPitchProcessor);
