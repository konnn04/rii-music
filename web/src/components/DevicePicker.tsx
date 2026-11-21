import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { deviceId, listDevices, transferTo, type Device } from "@/player/sync";
import { useRemoteView } from "@/player/view";
import { usePlayback } from "@/player/store";
import { t } from "@/i18n";
import { IconButton } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";

/** "Chọn thiết bị phát": which of the user's open apps plays, and moving it there. */
export function DevicesButton({ size = 20, className = "" }: { size?: number; className?: string }) {
  const remote = useRemoteView();
  const localPlaying = usePlayback((s) => s.isPlaying);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const load = () => {
    setDevices(null);
    listDevices().then(setDevices, () => setDevices([]));
  };
  const pick = async (d: Device) => {
    const leading = d.deviceId === deviceId ? localPlaying && !remote : d.playing;
    if (leading) return;
    try {
      if (d.deviceId !== deviceId) toast(t("ui.remote.switching", { device: d.deviceName }));
      await transferTo(d.deviceId);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  // This device first, then the others (the server lists the ones open in the last 90 s).
  const list = devices ? [...devices.filter((d) => d.deviceId === deviceId), ...devices.filter((d) => d.deviceId !== deviceId)] : null;
  return (
    <DropdownMenu.Root modal={false} onOpenChange={(o) => o && load()}>
      <DropdownMenu.Trigger asChild>
        <IconButton icon="devices" label={t("ui.remote.devicesButton")} active={!!remote} size={size} tooltip={false} className={className} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" side="top" sideOffset={8} className="menu-content z-[60] w-72 max-w-[calc(100vw-16px)]">
          <DropdownMenu.Label className="px-3 py-2 text-overline uppercase text-fg-muted">{t("ui.remote.devicesTitle")}</DropdownMenu.Label>
          {!list ? (
            <div className="flex justify-center py-3 text-fg-muted">
              <Icon name="loader" />
            </div>
          ) : (
            <>
              {list.map((d) => {
                const me = d.deviceId === deviceId;
                const leading = me ? localPlaying && !remote : d.playing;
                return (
                  <DropdownMenu.Item key={d.deviceId} className="menu-item !h-auto py-2" onSelect={() => void pick(d)}>
                    <Icon name={/iPhone|Android|iPad/.test(d.deviceName) ? "headphones" : "devices"} size={20} className={leading ? "text-accent" : "text-fg-muted"} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate ${leading ? "text-accent" : ""}`}>{me ? t("ui.remote.thisDevice") : d.deviceName}</span>
                      <span className="block truncate text-caption text-fg-muted">
                        {me ? d.deviceName : leading ? t("ui.remote.playingNow") : d.active ? t("ui.remote.lastHere") : ""}
                      </span>
                    </span>
                    {leading && <Icon name="playing" size={18} className="text-accent" />}
                  </DropdownMenu.Item>
                );
              })}
              {list.filter((d) => d.deviceId !== deviceId).length === 0 && (
                <p className="px-3 pb-2 pt-1 text-caption text-fg-muted">{t("ui.remote.noOther")}</p>
              )}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
