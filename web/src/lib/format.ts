import { lang, locale, t } from "@/i18n";

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export const fmtMs = (ms: number) => fmtTime(ms / 1000);

export function fmtTotal(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return t("ui.time.minutes", { n: min });
  const h = Math.floor(min / 60);
  return t("ui.time.hoursMinutes", { h, m: min % 60 });
}

const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
export function fmtAgo(ts: number): string {
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return t("common.time.justNow");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(ts).toLocaleDateString(locale());
}

export const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(locale());

export function plural(n: number, word: string) {
  return `${n.toLocaleString(locale())} ${word}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toLocaleString(locale(), { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(n / (1 << 20)).toLocaleString(locale())} MB`;
}
