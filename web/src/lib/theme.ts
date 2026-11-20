import type { Settings } from "./api";

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
