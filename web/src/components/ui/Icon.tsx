import type { SVGProps } from "react";
import { icons, type IconName } from "@/lib/icons";

export type { IconName };

export function Icon({ name, size = 24, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const i = icons[name];
  const filled = "fill" in i && i.fill;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 1 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${name === "loader" ? "animate-spin" : ""} ${className ?? ""}`}
      {...rest}
    >
      <path d={i.d} />
    </svg>
  );
}
