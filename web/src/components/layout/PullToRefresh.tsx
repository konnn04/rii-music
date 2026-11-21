import { useEffect, useRef, useState } from "react";
import { queryClient } from "@/lib/queries";
import { Icon } from "../ui/Icon";
import { t } from "@/i18n";

const TRIGGER = 64; // px of pull (after resistance) that refreshes
const MAX = 96;

/**
 * Touch devices: the browser's own pull-to-refresh (a full reload) is off
 * (overscroll-behavior). Instead:
 *  - pulling down the content while it is at the top reloads this page's data
 *    in place (active queries), without leaving the app;
 *  - pulling down from the header (the very top edge) reloads the whole page.
 */
export function PullToRefresh({ scrollEl, headerEl }: { scrollEl: HTMLElement | null; headerEl: HTMLElement | null }) {
  const [pull, setPull] = useState(0);
  const [full, setFull] = useState(false); // started on the header: whole-page reload
  const [busy, setBusy] = useState(false);
  const state = useRef<{ y0: number; active: boolean; full: boolean; pull: number } | null>(null);

  useEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) return;
    const targets = [scrollEl, headerEl].filter((x): x is HTMLElement => !!x);
    if (!targets.length) return;

    const start = (e: TouchEvent) => {
      if (busy || e.touches.length !== 1) return;
      const onHeader = !!headerEl && headerEl.contains(e.target as Node);
      if (!onHeader && (scrollEl?.scrollTop ?? 1) > 0) return;
      state.current = { y0: e.touches[0].clientY, active: false, full: onHeader, pull: 0 };
    };
    const move = (e: TouchEvent) => {
      const s = state.current;
      if (!s) return;
      const dy = e.touches[0].clientY - s.y0;
      if (dy <= 0 || (!s.full && (scrollEl?.scrollTop ?? 0) > 0)) {
        if (s.active) setPull(0);
        state.current = null;
        return;
      }
      s.active = true;
      s.pull = Math.min(MAX, dy * 0.5); // resistance
      setFull(s.full);
      setPull(s.pull);
    };
    const end = () => {
      const s = state.current;
      state.current = null;
      if (!s?.active) return;
      if (s.pull < TRIGGER) return setPull(0);
      if (s.full) return location.reload();
      setPull(TRIGGER);
      setBusy(true);
      queryClient
        .refetchQueries({ type: "active" })
        .catch(() => {})
        .finally(() => {
          setBusy(false);
          setPull(0);
        });
    };
    for (const el of targets) {
      el.addEventListener("touchstart", start, { passive: true });
      el.addEventListener("touchmove", move, { passive: true });
      el.addEventListener("touchend", end);
      el.addEventListener("touchcancel", end);
    }
    return () => {
      for (const el of targets) {
        el.removeEventListener("touchstart", start);
        el.removeEventListener("touchmove", move);
        el.removeEventListener("touchend", end);
        el.removeEventListener("touchcancel", end);
      }
    };
  }, [scrollEl, headerEl, busy]);

  if (pull <= 0 && !busy) return null;
  const ready = pull >= TRIGGER;
  return (
    <div
      role="status"
      aria-label={full ? t("ui.pull.reloadPage") : t("ui.pull.refresh")}
      className="pointer-events-none fixed left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full bg-surface-3 px-3 py-2 text-caption shadow-float"
      style={{ top: `calc(env(safe-area-inset-top) + ${8 + pull * 0.6}px)`, opacity: Math.min(1, pull / TRIGGER + (busy ? 1 : 0)) }}
    >
      <Icon
        name={busy ? "loader" : "retry"}
        size={18}
        className={ready || busy ? "text-accent" : "text-fg-muted"}
        style={busy ? undefined : { transform: `rotate(${pull * 4}deg)` }}
      />
      <span className={ready ? "text-fg" : "text-fg-muted"}>
        {busy ? t("ui.pull.refreshing") : full ? (ready ? t("ui.pull.releaseReload") : t("ui.pull.reloadPage")) : ready ? t("ui.pull.release") : t("ui.pull.refresh")}
      </span>
    </div>
  );
}
