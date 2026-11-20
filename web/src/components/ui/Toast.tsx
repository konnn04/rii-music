import { create } from "zustand";
import { Icon, type IconName } from "./Icon";
import { t } from "@/i18n";

// Notifications: short toasts above the player (mobile) / player bar (desktop),
// with an optional title, icon and action button.

type Kind = "info" | "success" | "error" | "warning";
type Note = {
  id: number;
  text: string;
  title?: string;
  kind: Kind;
  icon?: IconName;
  action?: { label: string; onClick: () => void };
};
const useToasts = create<{ items: Note[] }>(() => ({ items: [] }));
let seq = 0;

export type NotifyOptions = {
  text: string;
  title?: string;
  kind?: Kind;
  icon?: IconName;
  action?: { label: string; onClick: () => void };
  /** ms; 0 keeps it until closed */
  duration?: number;
};

export function notify(o: NotifyOptions) {
  const id = ++seq;
  const kind = o.kind ?? "info";
  useToasts.setState((s) => ({ items: [...s.items.slice(-3), { id, text: o.text, title: o.title, kind, icon: o.icon, action: o.action }] }));
  const ms = o.duration ?? (kind === "error" ? 6000 : o.action ? 6000 : 3500);
  if (ms > 0) setTimeout(() => dismiss(id), ms);
  return id;
}

export function dismiss(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

/** Short form kept for existing calls. */
export function toast(text: string, kind: Kind = "info") {
  return notify({ text, kind });
}

const kindIcon: Record<Kind, IconName> = { info: "music-note", success: "check", error: "alert", warning: "alert" };
const kindColor: Record<Kind, string> = { info: "text-accent", success: "text-success", error: "text-danger", warning: "text-warning" };

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-4 bottom-[calc(var(--spacing-tabbar)+var(--spacing-miniplayer)+16px+env(safe-area-inset-bottom))] md:bottom-[calc(var(--spacing-playerbar)+16px)]"
      role="status"
      aria-live="polite"
    >
      {items.map((n) => (
        <div
          key={n.id}
          className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-control bg-surface-3 px-4 py-3 text-body-sm text-fg shadow-float animate-[toast-in_200ms_var(--ease-out)]"
        >
          <Icon name={n.icon ?? kindIcon[n.kind]} size={20} className={`mt-0.5 shrink-0 ${kindColor[n.kind]}`} />
          <div className="min-w-0 flex-1">
            {n.title && <div className="text-label">{n.title}</div>}
            <div className={`whitespace-pre-line break-words ${n.title ? "text-fg-muted" : ""}`}>{n.text}</div>
          </div>
          {n.action && (
            <button
              className="focus-ring -my-1 shrink-0 rounded-control px-2 py-1 text-label text-accent hover:bg-white/5"
              onClick={() => {
                n.action!.onClick();
                dismiss(n.id);
              }}
            >
              {n.action.label}
            </button>
          )}
          <button className="focus-ring -my-1 -mr-2 shrink-0 rounded-full p-1 text-fg-muted hover:text-fg" aria-label={t("common.close")} onClick={() => dismiss(n.id)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
