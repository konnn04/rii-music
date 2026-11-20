import type { Settings } from "./api";
import { usePlayback } from "@/player/store";

let mq: MediaQueryList | null = null;
let listener: (() => void) | null = null;

export function applyTheme(theme: Settings["theme"]) {
  localStorage.setItem("vang-theme", JSON.stringify(theme));
  const set = () => {
    const t = theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#F6F7F9" : "#0E0F12");
  };
  if (mq && listener) mq.removeEventListener("change", listener);
  if (theme === "system") {
    mq = matchMedia("(prefers-color-scheme: light)");
    listener = set;
    mq.addEventListener("change", set);
  }
  set();
}

// ── accent colour ───────────────────────────────────────────────────────

/**
 * Twelve accents around the colour wheel: hue, saturation, and the lightness
 * used in the light theme (yellows go darker to stay readable on white).
 * "indigo" is the original design colour and keeps the exact token values.
 */
export const ACCENTS: { id: string; h: number; s: number; light: number }[] = [
  { id: "red", h: 0, s: 85, light: 46 },
  { id: "orange", h: 24, s: 90, light: 42 },
  { id: "amber", h: 38, s: 92, light: 36 },
  { id: "yellow", h: 50, s: 90, light: 32 },
  { id: "lime", h: 84, s: 62, light: 32 },
  { id: "green", h: 145, s: 55, light: 34 },
  { id: "teal", h: 172, s: 60, light: 32 },
  { id: "cyan", h: 190, s: 72, light: 36 },
  { id: "blue", h: 212, s: 85, light: 44 },
  { id: "indigo", h: 232, s: 100, light: 55 },
  { id: "violet", h: 262, s: 85, light: 52 },
  { id: "pink", h: 325, s: 80, light: 46 },
];

/** Swatch colour (as seen in the dark theme) for the settings picker. */
export const swatch = (a: (typeof ACCENTS)[number]) => `hsl(${a.h} ${a.s}% 72%)`;

let unsubSong: (() => void) | null = null;

function setVars(v: { h: number; s: number; light: number } | null) {
  const el = document.documentElement;
  if (!v) {
    delete el.dataset.accent;
    el.style.removeProperty("--ah");
    el.style.removeProperty("--as");
    el.style.removeProperty("--al");
    return;
  }
  el.dataset.accent = "";
  el.style.setProperty("--ah", String(v.h));
  el.style.setProperty("--as", `${v.s}%`);
  el.style.setProperty("--al", `${v.light}%`);
}

/** "hsl(210 48% 72%)" (from lib/accent) → hue / saturation. */
function parseHsl(c: string | null) {
  const m = c?.match(/hsl\((\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%/);
  return m ? { h: +m[1], s: +m[2], light: 40 } : null;
}

/** Apply an accent: one of ACCENTS, or "song" to follow the playing track's cover. */
export function applyAccent(mode: string) {
  unsubSong?.();
  unsubSong = null;
  if (mode === "song") {
    const follow = (c: string | null) => {
      const v = parseHsl(c);
      setVars(v);
      localStorage.setItem("vang-accent", JSON.stringify(v));
    };
    follow(usePlayback.getState().accent);
    unsubSong = usePlayback.subscribe((s, prev) => s.accent !== prev.accent && follow(s.accent));
    return;
  }
  const a = ACCENTS.find((x) => x.id === mode);
  const v = a && a.id !== "indigo" ? a : null;
  setVars(v);
  localStorage.setItem("vang-accent", JSON.stringify(v));
}
