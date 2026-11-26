import { ContextMenu, DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useRef, type MouseEvent, type ReactNode, type TouchEvent } from "react";
import type { Track } from "@/lib/api";
import { useCanHover, useIsMobile } from "@/lib/useMedia";
import { Icon } from "./ui/Icon";
import { openDialog, useTrackActions, type TrackContext } from "./dialogs";
import { t } from "@/i18n";

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

/** Touch long-press helper (≥ 450 ms, cancels on move > 10 px or scroll, suppresses subsequent click). */
export function useLongPress(onLongPress: () => void, enabled = true) {
  const cbRef = useRef(onLongPress);
  cbRef.current = onLongPress;
  const timerRef = useRef<number | null>(null);
  const resetRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const scrollCleanupRef = useRef<(() => void) | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
    scrollCleanupRef.current?.();
    scrollCleanupRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      clear();
      if (resetRef.current !== null) clearTimeout(resetRef.current);
    };
  }, [clear]);

  if (!enabled) return {};

  return {
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        clear();
        return;
      }
      firedRef.current = false;
      if (resetRef.current !== null) {
        clearTimeout(resetRef.current);
        resetRef.current = null;
      }
      const touch = e.touches[0];
      startRef.current = { x: touch.clientX, y: touch.clientY };
      const onScroll = () => clear();
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      scrollCleanupRef.current = () => window.removeEventListener("scroll", onScroll, true);
      timerRef.current = window.setTimeout(() => {
        clear();
        firedRef.current = true;
        navigator.vibrate?.(10);
        cbRef.current();
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: TouchEvent) => {
      if (timerRef.current === null || !startRef.current) return;
      const touch = e.touches[0];
      if (!touch) {
        clear();
        return;
      }
      const dx = touch.clientX - startRef.current.x;
      const dy = touch.clientY - startRef.current.y;
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) clear();
    },
    onTouchEnd: (e: TouchEvent) => {
      clear();
      if (firedRef.current) {
        e.preventDefault();
        resetRef.current = window.setTimeout(() => {
          firedRef.current = false;
          resetRef.current = null;
        }, 400);
      }
    },
    onTouchCancel: () => {
      clear();
      firedRef.current = false;
    },
    onClickCapture: (e: MouseEvent) => {
      if (firedRef.current) {
        firedRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onContextMenu: (e: MouseEvent) => {
      if (firedRef.current) e.preventDefault();
    },
  };
}

/** ⋯ button: dropdown on desktop, action sheet on mobile. */
export function TrackMenuButton({ track, ctx, className = "" }: { track: Track; ctx?: TrackContext; className?: string }) {
  const mobile = useIsMobile();
  const btnCls = `focus-ring state-layer inline-flex size-11 shrink-0 items-center justify-center rounded-full text-fg-muted hover:text-fg ${className}`;
  if (mobile) {
    return (
      <button
        aria-label={t("tracks.menu.moreAria", { title: track.title })}
        className={btnCls}
        onClick={(e) => {
          e.stopPropagation();
          openDialog({ kind: "trackSheet", track, ctx });
        }}
      >
        <Icon name="more-vertical" />
      </button>
    );
  }
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button aria-label={t("tracks.menu.moreAria", { title: track.title })} className={btnCls} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <Icon name="more" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="menu-content" onClick={(e) => e.stopPropagation()}>
          <MenuItems track={track} ctx={ctx} Item={DropdownMenu.Item} Separator={DropdownMenu.Separator} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Right-click menu on desktop, long-press action sheet on touch. */
export function TrackContextMenu({ track, ctx, children, disabled }: { track: Track; ctx?: TrackContext; children: ReactNode; disabled?: boolean }) {
  const canHover = useCanHover();
  const longPress = useLongPress(() => openDialog({ kind: "trackSheet", track, ctx }), !disabled);
  if (disabled) return <>{children}</>;
  if (!canHover) {
    return (
      <div className="contents" {...longPress}>
        {children}
      </div>
    );
  }
  return (
    <div className="contents" {...longPress}>
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="menu-content">
            <MenuItems track={track} ctx={ctx} Item={ContextMenu.Item} Separator={ContextMenu.Separator} />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}

export function MenuItems({
  track,
  ctx,
  Item,
  Separator,
}: {
  track: Track;
  ctx?: TrackContext;
  Item: typeof DropdownMenu.Item;
  Separator: typeof DropdownMenu.Separator;
}) {
  const { primary, danger } = useTrackActions(track, ctx);
  return (
    <>
      {primary.map((a) => (
        <Item key={a.key} className="menu-item" onSelect={a.run}>
          <Icon name={a.icon} size={20} className="text-fg-muted" />
          {a.label}
        </Item>
      ))}
      <Separator className="my-1 h-px bg-line" />
      {danger.map((a) => (
        <Item key={a.key} className={`menu-item ${a.danger ? "!text-danger" : ""}`} onSelect={a.run}>
          <Icon name={a.icon} size={20} />
          {a.label}
        </Item>
      ))}
    </>
  );
}
