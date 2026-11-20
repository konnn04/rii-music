import { useEffect } from "react";
import { engine } from "./engine";
import { usePlayer } from "./store";

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * Space play/pause · ←/→ seek 5 s · Shift+←/→ previous/next · M mute
 * L lyrics · Q queue · / focus search
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      // Let focused buttons/sliders keep their own Space/arrow behaviour.
      const role = (e.target as HTMLElement)?.getAttribute?.("role");
      const tag = (e.target as HTMLElement)?.tagName;
      const desktop = matchMedia("(min-width: 1024px)").matches;
      const p = usePlayer.getState();
      switch (e.key) {
        case " ":
          if (tag === "BUTTON" || role === "slider" || role === "tab") return;
          e.preventDefault();
          engine.toggle();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          if (role === "slider") return;
          e.preventDefault();
          if (e.shiftKey) e.key === "ArrowLeft" ? engine.prev() : engine.next();
          else engine.seekBy(e.key === "ArrowLeft" ? -5 : 5);
          break;
        case "m":
        case "M":
          p.toggleMute();
          break;
        case "l":
        case "L":
          if (desktop) p.setLyricsFull(!p.lyricsFull);
          else p.setNp(!(p.npOpen && p.npTab === "lyrics"), "lyrics");
          break;
        case "q":
        case "Q":
          if (desktop) p.togglePanel("queue");
          else p.setNp(!(p.npOpen && p.npTab === "queue"), "queue");
          break;
        case "/": {
          const s = document.getElementById("global-search");
          if (s) {
            e.preventDefault();
            s.focus();
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
