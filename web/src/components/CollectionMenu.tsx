import { ContextMenu } from "radix-ui";
import type { ReactNode } from "react";
import type { Track } from "@/lib/api";
import { usePlayer, type Source } from "@/player/store";
import { openDialog } from "./dialogs";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";
import { t, tn } from "@/i18n";

/** Right-click (and touch long-press) menu for album, artist, playlist and mix cards. */
export function CollectionContextMenu({
  load,
  source,
  children,
  openLabel,
  onOpen,
}: {
  load: () => Promise<Track[]>;
  source: Source;
  children: ReactNode;
  openLabel?: string;
  onOpen?: () => void;
}) {
  const run = async (fn: (tracks: Track[]) => void) => {
    try {
      const tracks = await load();
      if (!tracks.length) {
        toast(t("ui.menu.empty"));
        return;
      }
      fn(tracks);
    } catch (err) {
      toast((err as Error)?.message || t("common.error"), "error");
    }
  };

  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content">
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => void run((tracks) => usePlayer.getState().playList(tracks, 0, source, { shuffle: false }))}
          >
            <Icon name="play" size={20} className="text-fg-muted" />
            {t("ui.menu.play")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => void run((tracks) => usePlayer.getState().playList(tracks, -1, source, { shuffle: true }))}
          >
            <Icon name="shuffle" size={20} className="text-fg-muted" />
            {t("ui.menu.shuffle")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() =>
              void run((tracks) => {
                usePlayer.getState().playNext(tracks);
                toast(tn("ui.menu.addedNext", tracks.length));
              })
            }
          >
            <Icon name="queue" size={20} className="text-fg-muted" />
            {t("ui.menu.playNext")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() =>
              void run((tracks) => {
                usePlayer.getState().addToQueue(tracks);
                toast(tn("ui.menu.addedQueue", tracks.length));
              })
            }
          >
            <Icon name="plus" size={20} className="text-fg-muted" />
            {t("ui.menu.addToQueue")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => void run((tracks) => openDialog({ kind: "addToPlaylist", trackIds: tracks.map((tr) => tr.id) }))}
          >
            <Icon name="playlist-add" size={20} className="text-fg-muted" />
            {t("ui.menu.addToPlaylist")}
          </ContextMenu.Item>
          {onOpen && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <ContextMenu.Item className="menu-item" onSelect={onOpen}>
                <Icon name="chevron-right" size={20} className="text-fg-muted" />
                {openLabel ?? t("ui.menu.open")}
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
