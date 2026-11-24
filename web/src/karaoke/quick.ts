// Quick center-channel vocal remover: cancels L/R center above 150 Hz while
// preserving mono bass below 150 Hz, crossfaded with the dry signal.

export class VocalRemover {
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: AudioContext;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private enabled = false;
  private vocal = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.input.channelCountMode = "explicit";
    this.input.channelCount = 2;

    this.output = ctx.createGain();
    this.output.channelCountMode = "explicit";
    this.output.channelCount = 2;

    // Dry path
    this.dryGain = ctx.createGain();
    this.dryGain.channelCountMode = "explicit";
    this.dryGain.channelCount = 2;
    this.dryGain.gain.value = 1;
    this.input.connect(this.dryGain).connect(this.output);

    // Split stereo into L and R
    const splitter = ctx.createChannelSplitter(2);
    splitter.channelCountMode = "explicit";
    splitter.channelCount = 2;
    this.input.connect(splitter);

    // High-pass (150 Hz) of (L - R)
    const invR = ctx.createGain();
    invR.channelCountMode = "explicit";
    invR.channelCount = 1;
    invR.gain.value = -1;

    const diff = ctx.createGain();
    diff.channelCountMode = "explicit";
    diff.channelCount = 1;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 150;
    hp.channelCountMode = "explicit";
    hp.channelCount = 1;

    splitter.connect(diff, 0);
    splitter.connect(invR, 1);
    invR.connect(diff);
    diff.connect(hp);

    // Low-pass (150 Hz) of (L + R) / 2 to keep bass and kick
    const sum = ctx.createGain();
    sum.channelCountMode = "explicit";
    sum.channelCount = 1;
    sum.gain.value = 0.5;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 150;
    lp.channelCountMode = "explicit";
    lp.channelCount = 1;

    splitter.connect(sum, 0);
    splitter.connect(sum, 1);
    sum.connect(lp);

    // Combine and route mono result to both L and R
    const removed = ctx.createGain();
    removed.channelCountMode = "explicit";
    removed.channelCount = 1;
    hp.connect(removed);
    lp.connect(removed);

    const merger = ctx.createChannelMerger(2);
    removed.connect(merger, 0, 0);
    removed.connect(merger, 0, 1);

    this.wetGain = ctx.createGain();
    this.wetGain.channelCountMode = "explicit";
    this.wetGain.channelCount = 2;
    this.wetGain.gain.value = 0;
    merger.connect(this.wetGain).connect(this.output);
  }

  setEnabled(b: boolean): void {
    this.enabled = b;
    this.update();
  }

  setVocal(v: number): void {
    this.vocal = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    this.update();
  }

  private update(): void {
    const t = this.ctx.currentTime;
    const g1 = this.enabled ? this.vocal : 1;
    const g2 = this.enabled ? 1 - this.vocal : 0;
    this.dryGain.gain.setTargetAtTime(g1, t, 0.05);
    this.wetGain.gain.setTargetAtTime(g2, t, 0.05);
  }
}
