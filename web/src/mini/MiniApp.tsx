import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/i18n";
import "../styles/app.css";

type MiniState = {
  title: string;
  artist: string;
  playing: boolean;
  cover: string;
};

const empty: MiniState = { title: "", artist: "", playing: false, cover: "" };

const invoke = <T = unknown,>(cmd: string, args?: Record<string, unknown>) => window.__TAURI__?.core?.invoke<T>(cmd, args);

function MiniApp() {
  const [state, setState] = useState<MiniState>(empty);
  const [imgErr, setImgErr] = useState(false);

  useEffect(() => {
    setImgErr(false);
  }, [state.cover]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void invoke<MiniState>("mini_state")
      ?.then((s) => {
        if (!cancelled && s) setState(s);
      })
      .catch(() => {});

    void window.__TAURI__?.event
      ?.listen<MiniState>("rii:np", (e) => {
        if (!cancelled && e.payload) setState(e.payload);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const send = (cmd: "toggle" | "next" | "prev" | "show") => {
    void invoke("mini_cmd", { cmd })?.catch(() => {});
  };

  const close = () => {
    void invoke("toggle_mini_player")?.catch(() => {});
  };

  return (
    <div
      data-now-playing
      data-tauri-drag-region
      className="flex h-[96px] w-[320px] select-none items-center gap-3 overflow-hidden bg-[#0E0F12] p-3 text-fg"
    >
      {state.cover && !imgErr ? (
        <img
          src={state.cover}
          alt=""
          draggable={false}
          data-tauri-drag-region
          onError={() => setImgErr(true)}
          className="size-16 shrink-0 rounded-control bg-surface-3 object-cover"
        />
      ) : (
        <div data-tauri-drag-region className="flex size-16 shrink-0 items-center justify-center rounded-control bg-surface-3 text-fg-subtle">
          <Icon name="music-note" size={24} />
        </div>
      )}

      <div className="flex h-16 min-w-0 flex-1 flex-col justify-between">
        <div className="flex items-start gap-1">
          <div data-tauri-drag-region className="min-w-0 flex-1">
            <div data-tauri-drag-region className="truncate text-label leading-tight text-fg">
              {state.title || t("ui.player.nothingPlaying")}
            </div>
            <div data-tauri-drag-region className="truncate text-caption leading-tight text-fg-muted">
              {state.artist}
            </div>
          </div>

          <div className="-mr-1 -mt-1 flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => send("show")}
              aria-label={t("player.miniOpenApp")}
              title={t("player.miniOpenApp")}
              className="focus-ring state-layer flex size-6 items-center justify-center rounded-full text-fg-muted hover:text-fg"
            >
              <Icon name="sidebar" size={14} />
            </button>
            <button
              type="button"
              onClick={close}
              aria-label={t("common.close")}
              title={t("common.close")}
              className="focus-ring state-layer flex size-6 items-center justify-center rounded-full text-fg-muted hover:text-fg"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => send("prev")}
            aria-label={t("ui.player.prevTrack")}
            title={t("ui.player.prevTrack")}
            className="focus-ring state-layer flex size-7 items-center justify-center rounded-full text-fg-muted hover:text-fg"
          >
            <Icon name="skip-back" size={16} />
          </button>
          <button
            type="button"
            onClick={() => send("toggle")}
            aria-label={state.playing ? t("common.pause") : t("common.play")}
            title={state.playing ? t("common.pause") : t("common.play")}
            className="focus-ring flex size-7 items-center justify-center rounded-full bg-fg text-[#0E0F12] transition-transform hover:scale-105 active:scale-95"
          >
            <Icon name={state.playing ? "pause" : "play"} size={14} />
          </button>
          <button
            type="button"
            onClick={() => send("next")}
            aria-label={t("ui.player.nextTrack")}
            title={t("ui.player.nextTrack")}
            className="focus-ring state-layer flex size-7 items-center justify-center rounded-full text-fg-muted hover:text-fg"
          >
            <Icon name="skip-forward" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function mount(): void {
  document.documentElement.dataset.theme = "dark";
  for (const el of [document.documentElement, document.body]) {
    el.style.background = "#0E0F12";
    el.style.overflow = "hidden";
    el.style.userSelect = "none";
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MiniApp />
    </StrictMode>,
  );
}
