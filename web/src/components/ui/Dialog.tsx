import { Dialog as D } from "radix-ui";
import type { ReactNode } from "react";
import { IconButton } from "./Button";
import { t } from "@/i18n";

/** Dialog on desktop, bottom sheet on mobile. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  top = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Above full-screen overlays such as the karaoke screen. */
  top?: boolean;
}) {
  const z = top ? "z-[60]" : "z-[50]";
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={`fixed inset-0 ${z} bg-scrim animate-[fade-in_150ms_ease-out]`} />
        <D.Content
          className={`fixed inset-x-0 bottom-0 ${z} flex max-h-[90dvh] flex-col rounded-t-sheet bg-surface-3 pb-safe shadow-float animate-[sheet-up_250ms_var(--ease-out)] focus:outline-none
            md:inset-auto md:left-1/2 md:top-1/2 md:w-[min(480px,calc(100vw-32px))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-card md:pb-0 md:animate-[fade-in_150ms_ease-out]`}
        >
          <div className="flex items-start gap-2 px-6 pt-5">
            <div className="min-w-0 flex-1">
              <D.Title className="text-title-3">{title}</D.Title>
              <D.Description className={description ? "mt-1 text-body-sm text-fg-muted" : "sr-only"}>{description ?? title}</D.Description>
            </div>
            <D.Close asChild>
              <IconButton icon="close" label={t("common.close")} tooltip={false} className="-mr-3 -mt-2" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 px-6 pb-5">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
