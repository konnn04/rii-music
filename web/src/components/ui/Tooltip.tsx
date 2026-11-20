import { Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root delayDuration={500}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[80] hidden rounded-xs bg-surface-3 px-2 py-1 text-caption text-fg shadow-float select-none [@media(hover:hover)]:block"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
