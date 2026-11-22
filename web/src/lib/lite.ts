// "Chế độ nhẹ" (lite mode) for weak devices: fewer visual effects so the
// main thread has time for audio (on slow machines heavy effects make playback
// stutter). Auto by default: on when the device looks weak (few cores, little
// memory, reduced motion asked by the OS) or when frames keep dropping while
// music plays. Applied as <html data-lite="1">; CSS and components read it.

import { create } from "zustand";
import { usePlayback } from "@/player/store";

export type LiteMode = "auto" | "on" | "off";
const KEY = "rii-lite";

type LiteState = { mode: LiteMode; active: boolean; reason: "" | "device" | "jank" | "motion" | "manual" };

export const useLite = create<LiteState>(() => ({ mode: "auto", active: false, reason: "" }));

/** Cheap hints, available at once. */
function weakDevice(): LiteState["reason"] {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "motion";
  const cores = navigator.hardwareConcurrency || 8;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (cores <= 2 || mem <= 2 || (cores <= 4 && mem <= 4)) return "device";
  return "";
}

function apply() {
  const { active } = useLite.getState();
  if (active) document.documentElement.dataset.lite = "1";
  else delete document.documentElement.dataset.lite;
}

export function setLiteMode(mode: LiteMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private mode */
  }
  decide(mode, jankSeen ? "jank" : "");
}

let jankSeen = false;

function decide(mode: LiteMode, runtime: LiteState["reason"]) {
  let active = false;
  let reason: LiteState["reason"] = "";
  if (mode === "on") [active, reason] = [true, "manual"];
  else if (mode === "auto") {
    reason = weakDevice() || runtime;
    active = reason !== "";
  }
  useLite.setState({ mode, active, reason });
  apply();
}

/** While music plays, watch for dropped frames; too many → lite (auto mode only). */
function watchJank() {
  let last = 0;
  let frames = 0;
  let slow = 0;
  let windowStart = 0;
  const tick = (now: number) => {
    const s = useLite.getState();
    if (s.mode !== "auto" || s.active) {
      raf = 0;
      return;
    }
    if (last) {
      frames++;
      if (now - last > 60) slow++; // a frame took > 60 ms (≈ 4 dropped at 60 Hz)
    }
    last = now;
    if (!windowStart) windowStart = now;
    if (now - windowStart > 8000) {
      // Over 8 s of playback: more than one frame in five was slow.
      if (frames > 30 && slow / frames > 0.2) {
        jankSeen = true;
        decide("auto", "jank");
        raf = 0;
        return;
      }
      frames = slow = 0;
      windowStart = now;
    }
    raf = requestAnimationFrame(tick);
  };
  let raf = 0;
  usePlayback.subscribe((p, prev) => {
    if (p.isPlaying === prev.isPlaying) return;
    if (p.isPlaying && !raf && document.visibilityState === "visible") {
      last = windowStart = frames = slow = 0;
      raf = requestAnimationFrame(tick);
    } else if (!p.isPlaying && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  });
}

let started = false;
export function initLite() {
  if (started) return;
  started = true;
  let mode: LiteMode = "auto";
  try {
    const v = localStorage.getItem(KEY);
    if (v === "on" || v === "off" || v === "auto") mode = v;
  } catch {
    /* private mode */
  }
  decide(mode, "");
  watchJank();
}

export const isLite = () => useLite.getState().active;
