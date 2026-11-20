// Hẹn giờ ngủ: stop after N minutes (the music fades out over the last
// seconds) or at the end of the song playing.

import { create } from "zustand";

export const SLEEP_FADE_SEC = 12;
export const SLEEP_CHOICES = [5, 15, 30, 45, 60, 90] as const;

type SleepState = {
  /** ms timestamp when playback stops; null = no timer. */
  endsAt: number | null;
  /** Stop when the current song ends instead (no crossfade into the next). */
  endOfTrack: boolean;
};

export const useSleep = create<SleepState>(() => ({ endsAt: null, endOfTrack: false }));

let timer: number | null = null;
let fadeHook: ((sec: number) => void) | null = null;

/** The engine registers how to fade out and pause. */
export function onSleepFade(fn: (sec: number) => void) {
  fadeHook = fn;
}

export function setSleep(choice: number | "track" | null) {
  if (timer) clearInterval(timer);
  timer = null;
  if (choice === null) return useSleep.setState({ endsAt: null, endOfTrack: false });
  if (choice === "track") return useSleep.setState({ endsAt: null, endOfTrack: true });
  useSleep.setState({ endsAt: Date.now() + choice * 60_000, endOfTrack: false });
  timer = window.setInterval(() => {
    const at = useSleep.getState().endsAt;
    if (!at) return;
    if (Date.now() >= at - SLEEP_FADE_SEC * 1000) {
      clearInterval(timer!);
      timer = null;
      useSleep.setState({ endsAt: null });
      fadeHook?.(Math.max(1, Math.min(SLEEP_FADE_SEC, (at - Date.now()) / 1000)));
    }
  }, 1000);
}

/** Called by the engine when a song ends: true if playback should stop here. */
export function consumeEndOfTrack() {
  if (!useSleep.getState().endOfTrack) return false;
  useSleep.setState({ endOfTrack: false });
  return true;
}
