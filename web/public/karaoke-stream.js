// AudioWorkletProcessor: sparse segmented instrumental stream synced to an <audio> clock.

class RiiKStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._segLen = 0;
    this._count = 0;
    this._total = 0;
    this._srcRate = sampleRate;
    this._segs = [];
    this._playing = false;
    this._rate = 1;
    this._pos = 0;
    this._anchored = false;
    this._stopped = false;

    this._fadeLen = Math.max(1, Math.round(sampleRate * 0.005));
    this._gain = 0;
    this._lastL = 0;
    this._lastR = 0;

    this._xfadePos = 0;
    this._xfadeRem = 0;

    this._inGap = false;
    this._lastGapAt = -1;

    this._sL = 0;
    this._sR = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "init") {
        this._segLen = msg.segLen | 0;
        this._count = msg.count | 0;
        this._total = msg.total | 0;
        this._srcRate = typeof msg.srcRate === "number" && msg.srcRate > 0 ? msg.srcRate : sampleRate;
        this._segs = new Array(Math.max(0, this._count)).fill(null);
        this._inGap = false;
        this._lastGapAt = -1;
        this._xfadeRem = 0;
      } else if (msg.type === "seg") {
        const idx = msg.index | 0;
        if (idx >= 0 && idx < this._segs.length && msg.left && msg.right) {
          this._segs[idx] = { left: msg.left, right: msg.right };
        }
      } else if (msg.type === "sync") {
        const playing = !!msg.playing;
        const rate = typeof msg.rate === "number" && Number.isFinite(msg.rate) && msg.rate > 0 ? msg.rate : 1;
        const time = typeof msg.time === "number" && Number.isFinite(msg.time) ? msg.time : 0;
        const at = typeof msg.at === "number" && Number.isFinite(msg.at) ? msg.at : currentTime;
        const targetTime = Math.max(0, time + (playing ? (currentTime - at) * rate : 0));
        const targetPos = targetTime * this._srcRate;

        if (!this._anchored) {
          this._pos = targetPos;
          this._anchored = true;
          this._gain = 0;
          this._xfadeRem = 0;
        } else if (Math.abs(targetPos - this._pos) > 0.02 * this._srcRate) {
          if (this._playing && playing && this._gain > 0) {
            this._xfadePos = this._pos;
            this._xfadeRem = this._fadeLen;
          } else {
            this._gain = 0;
            this._xfadeRem = 0;
          }
          this._pos = targetPos;
        }
        this._playing = playing;
        this._rate = rate;
      } else if (msg.type === "stop") {
        this._stopped = true;
      }
    };
  }

  _sampleAt(pos) {
    if (pos < 0 || pos >= this._total || this._segLen <= 0) return false;
    const idx = Math.floor(pos);
    const segIdx = Math.floor(idx / this._segLen);
    const seg = this._segs[segIdx];
    if (!seg) return false;
    const off = idx - segIdx * this._segLen;
    if (off < 0 || off >= seg.left.length) return false;

    const frac = pos - idx;
    if (frac === 0) {
      this._sL = seg.left[off];
      this._sR = seg.right[off];
      return true;
    }

    let nL = seg.left[off];
    let nR = seg.right[off];
    if (off + 1 < seg.left.length) {
      nL = seg.left[off + 1];
      nR = seg.right[off + 1];
    } else if (segIdx + 1 < this._count) {
      const next = this._segs[segIdx + 1];
      if (next && next.left.length > 0) {
        nL = next.left[0];
        nR = next.right[0];
      }
    }
    this._sL = seg.left[off] + frac * (nL - seg.left[off]);
    this._sR = seg.right[off] + frac * (nR - seg.right[off]);
    return true;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return !this._stopped;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const frames = outL.length;

    if (this._stopped) {
      outL.fill(0);
      if (outR) outR.fill(0);
      return false;
    }

    const fadeStep = 1 / this._fadeLen;

    if (!this._playing || !this._anchored || this._segLen <= 0) {
      for (let i = 0; i < frames; i++) {
        if (this._gain > 0) {
          this._gain = Math.max(0, this._gain - fadeStep);
          outL[i] = this._lastL * this._gain;
          if (outR) outR[i] = this._lastR * this._gain;
        } else {
          outL[i] = 0;
          if (outR) outR[i] = 0;
        }
      }
      return true;
    }

    const step = (this._srcRate / sampleRate) * this._rate;
    let hadGap = false;
    let hadSample = false;

    for (let i = 0; i < frames; i++) {
      const inRange = this._pos >= 0 && this._pos < this._total;
      const hasNew = inRange && this._sampleAt(this._pos);
      let sL = hasNew ? this._sL : 0;
      let sR = hasNew ? this._sR : 0;

      if (this._xfadeRem > 0) {
        const w = this._xfadeRem / this._fadeLen;
        const hasOld = this._sampleAt(this._xfadePos);
        const oL = hasOld ? this._sL : 0;
        const oR = hasOld ? this._sR : 0;
        sL = oL * w + sL * (1 - w);
        sR = oR * w + sR * (1 - w);
        this._xfadePos += step;
        this._xfadeRem--;
      }

      if (hasNew) {
        hadSample = true;
        if (this._gain < 1) this._gain = Math.min(1, this._gain + fadeStep);
        const l = sL * this._gain;
        const r = sR * this._gain;
        outL[i] = l;
        if (outR) outR[i] = r;
        this._lastL = sL;
        this._lastR = sR;
      } else {
        if (inRange) hadGap = true;
        if (this._gain > 0) {
          this._gain = Math.max(0, this._gain - fadeStep);
          outL[i] = this._lastL * this._gain;
          if (outR) outR[i] = this._lastR * this._gain;
        } else {
          outL[i] = 0;
          if (outR) outR[i] = 0;
        }
      }

      this._pos += step;
    }

    if (hadGap) {
      this._inGap = true;
      if (currentTime - this._lastGapAt >= 0.25) {
        this._lastGapAt = currentTime;
        this.port.postMessage({ type: "gap", time: this._pos / this._srcRate });
      }
    } else if (hadSample && this._inGap) {
      this._inGap = false;
      this.port.postMessage({ type: "covered" });
    }

    return true;
  }
}

registerProcessor("rii-kstream", RiiKStreamProcessor);
