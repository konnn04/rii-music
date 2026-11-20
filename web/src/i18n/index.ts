// Tiny i18n: JSON dictionaries per language and area (web/src/i18n/locales/<lang>/<area>.json),
// keys "area.path.to.key", "{name}" placeholders. The language is chosen once at
// start-up (account setting → localStorage → browser); switching reloads the page.

export type Lang = "vi" | "en";
export const LANGS: { code: Lang; label: string }[] = [
  { code: "vi", label: "Tiếng Việt" },
  { code: "en", label: "English" },
];

type Dict = Record<string, unknown>;
const files = import.meta.glob<{ default: Dict }>("./locales/*/*.json", { eager: true });

function load(lang: Lang): Dict {
  const out: Dict = {};
  for (const [path, mod] of Object.entries(files)) {
    const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
    if (m && m[1] === lang) out[m[2]] = mod.default;
  }
  return out;
}

function detect(): Lang {
  try {
    const saved = localStorage.getItem("rii-lang");
    if (saved === "vi" || saved === "en") return saved;
  } catch {
    /* private mode */
  }
  return navigator.language?.toLowerCase().startsWith("vi") ? "vi" : navigator.language ? "en" : "vi";
}

export const lang: Lang = detect();
const dict = load(lang);
const fallback = lang === "vi" ? dict : load("vi");
document.documentElement.lang = lang;

function lookup(d: Dict, key: string): string | undefined {
  let cur: unknown = d;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Dict)) cur = (cur as Dict)[part];
    else return undefined;
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Translate: t("player.queue.title"), t("home.greeting", { name: "An" }). */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = lookup(dict, key) ?? lookup(fallback, key) ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** Plural-ish helper: picks key.one / key.other (English needs it, Vietnamese doesn't). */
export function tn(key: string, n: number, vars?: Record<string, string | number>): string {
  const k = n === 1 && lookup(dict, key + ".one") ? key + ".one" : key + ".other";
  return t(lookup(dict, k) || lookup(fallback, k) ? k : key, { n, ...vars });
}

/** Switch language: remembered locally (and in the account by the caller), page reloads. */
export function setLang(l: Lang) {
  localStorage.setItem("rii-lang", l);
  location.reload();
}

/** Remember the account's language without reloading if it already matches. */
export function syncLang(l: string | undefined) {
  if ((l === "vi" || l === "en") && l !== lang) {
    localStorage.setItem("rii-lang", l);
    location.reload();
  }
}

/** Server messages are Vietnamese; show them in the UI language. */
export function translateServer(msg: string): string {
  if (lang === "vi" || !msg) return msg;
  const errors = (dict.errors ?? {}) as Record<string, unknown> as Record<string, string>;
  if (typeof errors[msg] === "string") return errors[msg];
  // server-made labels with a fixed start ("Vì bạn hay nghe X", "Radio: …", stages)
  const prefixes = (errors._prefixes ?? {}) as unknown as Record<string, string>;
  if (prefixes[msg]) return prefixes[msg];
  let best = "";
  for (const p of Object.keys(prefixes)) if (msg.startsWith(p) && p.length > best.length) best = p;
  if (best) return prefixes[best] + msg.slice(best.length);
  // messages with a variable tail ("Đợi 12 giây rồi gửi lại mã")
  for (const [vi, en] of Object.entries(errors)) {
    if (vi.includes("{n}")) {
      const re = new RegExp("^" + vi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{n\\}", "(\\d+)") + "$");
      const m = msg.match(re);
      if (m) return en.replace("{n}", m[1]);
    }
  }
  return msg;
}

export const locale = () => (lang === "vi" ? "vi-VN" : "en-US");

/** Text that came from the server (reasons, stages, mix names) in the UI language. */
export const tsv = translateServer;
