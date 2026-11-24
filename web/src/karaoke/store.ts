import { create } from "zustand";

export type KaraokeMode = "off" | "quick" | "ai";

export type SepStatus = {
  trackId: string;
  phase: "model" | "decode" | "separate" | "save" | "done" | "error";
  progress: number;
  error?: string;
  /** Where the model runs: a GPU name, or "cpu" (WASM). */
  backend?: string;
};

export type KaraokeState = {
  mode: KaraokeMode;
  vocal: number;
  key: number;
  open: boolean;
  sep: SepStatus | null;
  ready: Record<string, true>;
};

const STORAGE_KEY = "rii-karaoke";

function parseMode(v: unknown): KaraokeMode {
  return v === "off" || v === "quick" || v === "ai" ? v : "off";
}

function clampVocal(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function clampKey(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(-6, Math.min(6, Math.round(v))) || 0;
}

function loadPersisted(): Pick<KaraokeState, "mode" | "vocal" | "key"> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: "off", vocal: 0, key: 0 };
    const data = JSON.parse(raw) as Record<string, unknown> | null;
    return {
      mode: parseMode(data?.mode),
      vocal: clampVocal(data?.vocal),
      key: clampKey(data?.key),
    };
  } catch {
    return { mode: "off", vocal: 0, key: 0 };
  }
}

function savePersisted(s: Pick<KaraokeState, "mode" | "vocal" | "key">) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: s.mode, vocal: s.vocal, key: s.key }));
  } catch {
    /* ignore */
  }
}

export const useKaraoke = create<KaraokeState>()(() => ({
  ...loadPersisted(),
  open: false,
  sep: null,
  ready: {},
}));

useKaraoke.subscribe((s, prev) => {
  if (s.mode !== prev.mode || s.vocal !== prev.vocal || s.key !== prev.key) {
    savePersisted(s);
  }
});

export function setKaraokeMode(m: KaraokeMode): void {
  useKaraoke.setState({ mode: parseMode(m) });
}

export function setVocal(v: number): void {
  useKaraoke.setState({ vocal: clampVocal(v) });
}

export function setKey(k: number): void {
  useKaraoke.setState({ key: clampKey(k) });
}

export function openKaraoke(open: boolean): void {
  useKaraoke.setState({ open: !!open });
}
