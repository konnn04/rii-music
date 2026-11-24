// Loader for the AudioWorklet pitch shifter (web/public/karaoke-pitch.js).

export type PitchShifter = {
  node: AudioWorkletNode;
  set(semitones: number): void;
};

const loaded = new WeakMap<AudioContext, Promise<void>>();

export async function createPitch(ctx: AudioContext): Promise<PitchShifter | null> {
  if (!ctx.audioWorklet) return null;
  try {
    let p = loaded.get(ctx);
    if (!p) {
      p = ctx.audioWorklet.addModule("/karaoke-pitch.js");
      loaded.set(ctx, p);
    }
    await p;
    const node = new AudioWorkletNode(ctx, "rii-pitch", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    const set = (semitones: number) => {
      const s = Math.max(-6, Math.min(6, Math.round(Number.isFinite(semitones) ? semitones : 0))) || 0;
      const param = node.parameters.get("semitones");
      if (param) param.setValueAtTime(s, ctx.currentTime);
      else node.port.postMessage({ semitones: s });
    };
    return { node, set };
  } catch {
    loaded.delete(ctx);
    return null;
  }
}
