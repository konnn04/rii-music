import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { t } from "@/i18n";

export function Empty({ icon = "music-note", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-surface-2 text-fg-muted">
        <Icon name={icon} size={32} />
      </div>
      <h3 className="text-title-3">{title}</h3>
      {children && <p className="max-w-sm text-body-sm text-fg-muted">{children}</p>}
      {action}
    </div>
  );
}

// Offline: under the error, the songs stored on this device (loaded on demand).
const OfflineShelf = lazy(() => import("@/components/OfflineShelf"));

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <>
    <Empty
      icon="alert"
      title={t("ui.error.loadFailed")}
      action={
        onRetry && (
          <button className="focus-ring state-layer h-11 rounded-control bg-surface-2 px-4 text-label" onClick={onRetry}>
            {t("common.retry")}
          </button>
        )
      }
    >
      {(error as Error)?.message}
    </Empty>
    <Suspense fallback={null}>
      <OfflineShelf />
    </Suspense>
    </>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xs bg-surface-4/60 ${className}`} />;
}

export function SectionHeader({ title, action, sub }: { title: string; action?: ReactNode; sub?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4 px-4 md:px-0">
      <div className="min-w-0">
        <h2 className="text-title-3 lg:text-title-2">{title}</h2>
        {sub && <p className="text-body-sm text-fg-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center py-16 text-fg-muted ${className}`}>
      <Icon name="loader" size={28} />
    </div>
  );
}

/** Animated equaliser shown on the playing row. */
export function Equalizer({ paused }: { paused?: boolean }) {
  return (
    <span className="flex h-4 w-4 items-end justify-center gap-[2px]" role="img" aria-label={t("ui.equalizer.playing")}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-full w-[3px] origin-bottom rounded-full bg-accent"
          style={{ animation: paused ? "none" : `eq 900ms ${i * 150}ms ease-in-out infinite alternate`, transform: paused ? "scaleY(0.35)" : undefined }}
        />
      ))}
    </span>
  );
}
