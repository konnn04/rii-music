const KEY = "rii-ui-scale";

export const UI_SCALES = [0.85, 0.9, 1, 1.1, 1.2] as const;

const isValid = (v: number) => Number.isFinite(v) && v >= 0.75 && v <= 1.5;

export function getUiScale(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return 1;
    const n = Number(raw);
    return isValid(n) ? n : 1;
  } catch {
    return 1;
  }
}

export function setUiScale(v: number) {
  const next = isValid(v) ? v : 1;
  try {
    if (next === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(next));
  } catch {
    // ignore storage errors
  }
  document.documentElement.style.fontSize = next === 1 ? "" : `${Math.round(next * 100)}%`;
}

export function applyUiScale() {
  const v = getUiScale();
  document.documentElement.style.fontSize = v === 1 ? "" : `${Math.round(v * 100)}%`;
}
