import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Tooltip } from "./Tooltip";
import { t } from "@/i18n";

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-fg-on-accent hover:bg-accent-hover active:bg-accent-pressed",
  secondary: "bg-surface-2 text-fg state-layer",
  ghost: "text-fg state-layer",
  danger: "bg-surface-2 text-danger state-layer",
};

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: IconName;
  loading?: boolean;
  size?: "md" | "sm";
  children?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = "secondary", icon, loading, size = "md", className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`focus-ring inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-colors duration-fast select-none
        disabled:opacity-50 disabled:pointer-events-none
        ${size === "md" ? "h-11 px-4 text-label" : "h-9 px-3 text-label"} ${variants[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Icon name="loader" size={20} /> : icon ? <Icon name={icon} size={20} /> : null}
      {children}
    </button>
  );
});

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  shortcut?: string;
  size?: number;
  active?: boolean;
  tooltip?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconBtnProps>(function IconButton(
  { icon, label, shortcut, size = 24, active, className = "", tooltip = true, ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      aria-label={label}
      aria-pressed={active}
      className={`focus-ring state-layer inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors duration-fast
        disabled:opacity-40 disabled:pointer-events-none ${active ? "text-accent" : "text-fg-muted hover:text-fg"} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
  if (!tooltip) return btn;
  return <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>{btn}</Tooltip>;
});

/** Large round play button. */
export function PlayButton({
  playing,
  onClick,
  size = 56,
  className = "",
  label,
  np,
}: {
  playing: boolean;
  onClick: () => void;
  size?: number;
  className?: string;
  label?: string;
  np?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label ?? (playing ? t("common.pause") : t("common.play"))}
      className={`focus-ring inline-flex shrink-0 items-center justify-center rounded-full transition-transform duration-fast active:scale-95
        ${np ? "bg-np-accent text-np-on-accent" : "bg-accent text-fg-on-accent hover:bg-accent-hover"} ${className}`}
      style={{ width: size, height: size }}
    >
      <Icon name={playing ? "pause" : "play"} size={Math.round(size * 0.45)} />
    </button>
  );
}
