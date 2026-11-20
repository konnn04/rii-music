import { useState } from "react";
import { dismissRemote, takeOver, useRemote } from "@/player/sync";
import { t } from "@/i18n";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";

/** "Đang phát trên Chrome · Windows — <bài> · Phát ở đây": another device has the session. */
export function RemoteBanner({ className = "" }: { className?: string }) {
  const s = useRemote((r) => r.session);
  const title = useRemote((r) => r.title);
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const take = async () => {
    setBusy(true);
    try {
      await takeOver();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className={`flex items-center gap-2 rounded-control bg-accent-soft px-3 py-2 text-body-sm ${className}`}>
      <Icon name="headphones" size={18} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate">
        {t(s.playing ? "ui.remote.playingOn" : "ui.remote.pausedOn", { device: s.deviceName })}
        {title && <span className="text-fg-muted"> · {title}</span>}
      </span>
      <button className="focus-ring h-8 shrink-0 rounded-full bg-accent px-3 text-label text-fg-on-accent disabled:opacity-60" onClick={take} disabled={busy}>
        {t("ui.remote.playHere")}
      </button>
      <button className="focus-ring flex size-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:text-fg" aria-label={t("common.close")} onClick={dismissRemote}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
