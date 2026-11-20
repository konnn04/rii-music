import { useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Icon } from "./Icon";
import { t } from "@/i18n";

// Explanations without walls of text: <Tip> is a small "i" that opens the
// text on tap / hover; <Hint> is a card shown once until dismissed.

export function Tip({ children, label, className = "" }: { children: ReactNode; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label ?? t("common.moreInfo")}
          className={`focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-fg-subtle hover:text-fg ${className}`}
          onMouseEnter={() => matchMedia("(hover: hover)").matches && setOpen(true)}
          onMouseLeave={() => matchMedia("(hover: hover)").matches && setOpen(false)}
        >
          <Icon name="info" size={16} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          sideOffset={6}
          collisionPadding={12}
          className="z-[80] max-w-72 rounded-control bg-surface-3 px-3 py-2 text-body-sm text-fg shadow-float animate-[fade-in_120ms_ease-out]"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {children}
          <Popover.Arrow className="fill-[var(--color-surface-3)]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const useSeen = create<{ seen: Record<string, true>; see: (id: string) => void; reset: () => void }>()(
  persist(
    (set) => ({
      seen: {},
      see: (id) => set((s) => ({ seen: { ...s.seen, [id]: true } })),
      reset: () => set({ seen: {} }),
    }),
    { name: "vang-hints" },
  ),
);

/** A tip card shown until the user dismisses it once. */
export function Hint({ id, children, icon = "lightbulb", className = "" }: { id: string; children: ReactNode; icon?: "lightbulb" | "info"; className?: string }) {
  const seen = useSeen((s) => s.seen[id]);
  const see = useSeen((s) => s.see);
  if (seen) return null;
  return (
    <div className={`flex items-start gap-3 rounded-control bg-accent-soft px-3 py-2.5 text-body-sm text-fg ${className}`} role="note">
      <Icon name={icon} size={18} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">{children}</div>
      <button className="focus-ring -my-1 shrink-0 rounded-control px-2 py-1 text-label text-accent hover:bg-white/5" onClick={() => see(id)}>
        {t("common.gotIt")}
      </button>
    </div>
  );
}

/** Show all one-time hints again (Cài đặt). */
export const resetHints = () => useSeen.getState().reset();
