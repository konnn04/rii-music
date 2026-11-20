import { usePlayer, type AutoplayMode } from "@/player/store";
import { notify } from "../ui/Toast";
import { Tooltip } from "../ui/Tooltip";
import { Icon } from "../ui/Icon";
import { t } from "@/i18n";

const order: AutoplayMode[] = ["off", "lib", "free"];

/** One switch for "Tự động gợi ý phát": off → library only → also new songs. */
export function AutoplayButton({ np, size = 20, className = "" }: { np?: boolean; size?: number; className?: string }) {
  const mode = usePlayer((s) => s.autoplayMode);
  const next = () => {
    const m = order[(order.indexOf(mode) + 1) % order.length];
    usePlayer.getState().setAutoplayMode(m);
    notify({ title: t(`player.autoplay.${m}.title`), text: t(`player.autoplay.${m}.text`), icon: "radio", kind: m === "off" ? "info" : "success" });
  };
  const on = mode !== "off";
  const color = on ? (np ? "text-np-accent" : "text-accent") : np ? "text-np-fg-muted" : "text-fg-muted";
  return (
    <Tooltip content={`${t("player.autoplay.label")}: ${t(`player.autoplay.${mode}.title`)}`}>
      <button
        onClick={next}
        aria-label={`${t("player.autoplay.label")}: ${t(`player.autoplay.${mode}.title`)}`}
        className={`focus-ring state-layer relative flex size-10 shrink-0 items-center justify-center rounded-full ${color} ${className}`}
      >
        <Icon name="radio" size={size} />
        {mode === "free" && (
          <span className={`absolute right-1 top-1 rounded-full px-1 text-[9px] font-bold leading-3 ${np ? "bg-np-accent text-np-on-accent" : "bg-accent text-fg-on-accent"}`}>+</span>
        )}
        {on && <span className={`absolute bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full ${np ? "bg-np-accent" : "bg-accent"}`} />}
      </button>
    </Tooltip>
  );
}
