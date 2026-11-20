import { ContextMenu, DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import type { Track } from "@/lib/api";
import { useIsMobile } from "@/lib/useMedia";
import { Icon } from "./ui/Icon";
import { openDialog, useTrackActions, type TrackContext } from "./dialogs";
import { t } from "@/i18n";

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

/** Right-click menu around a row (desktop only; mobile uses the ⋯ sheet). */
export function TrackContextMenu({ track, ctx, children, disabled }: { track: Track; ctx?: TrackContext; children: ReactNode; disabled?: boolean }) {
  if (disabled) return <>{children}</>;
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content">
          <MenuItems track={track} ctx={ctx} Item={ContextMenu.Item} Separator={ContextMenu.Separator} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
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
