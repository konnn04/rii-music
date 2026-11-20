// Music effect: the Now Playing / lyrics background "breathes" with the song.
// Bass hits make it pulse; overall loudness sets how far the colour spreads,
// so quiet passages stay calm and the chorus glows.
//
// The loop writes two numbers as CSS variables on the elements marked
// [data-beat] inside the surface (not the whole subtree, to keep style
// recalculation cheap): --beat (0–1, fast attack, quick release) and
// --energy (0–1, slow).

import { useEffect, type RefObject } from "react";
import { engine } from "@/player/engine";
import { usePlayback } from "@/player/store";

export function usePulse(root: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!enabled || !el) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let targets: HTMLElement[] = [];
    let lastScan = 0;
    let raf = 0;
    let beat = 0, energy = 0, bassAvg = 0.3, lastT = performance.now();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      const k = dt * 60; // per-frame constants are tuned for 60 fps
      const lv = usePlayback.getState().isPlaying ? engine.levels() : null;
      if (lv) {
        // Loudness in dB: about -40 dBFS (quiet intro) → 0, -12 dBFS (loud chorus) → 1.
        const db = 20 * Math.log10(Math.max(lv.rms, 1e-5));
        const loud = Math.min(1, Math.max(0, (db + 40) / 28));
        energy += (loud - energy) * (1 - Math.pow(1 - 0.05, k));
        bassAvg += (lv.bass - bassAvg) * (1 - Math.pow(1 - 0.025, k));
        // A kick: bass jumps above its recent average.
        const hit = Math.min(1, Math.max(0, lv.bass - bassAvg * 1.04) * 5.5);
        beat = Math.max(hit, beat * Math.pow(0.86, k));
      } else {
        energy *= Math.pow(0.95, k);
        beat *= Math.pow(0.86, k);
      }
      const b = beat * (0.35 + 0.65 * energy) * (reduced ? 0.3 : 1);
      if (now - lastScan > 1000) {
        targets = Array.from(el.querySelectorAll<HTMLElement>("[data-beat]"));
        lastScan = now;
      }
      const bs = b.toFixed(3), es = energy.toFixed(3);
      for (const t of targets) {
        t.style.setProperty("--beat", bs);
        t.style.setProperty("--energy", es);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      for (const t of el.querySelectorAll<HTMLElement>("[data-beat]")) {
        t.style.removeProperty("--beat");
        t.style.removeProperty("--energy");
      }
    };
  }, [root, enabled]);
}
