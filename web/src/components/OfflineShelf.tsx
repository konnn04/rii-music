// "Đã lưu trên máy": the songs stored on this device for offline listening,
// read from IndexedDB, so something can play when pages can't load.
import { useQuery } from "@tanstack/react-query";
import { t } from "@/i18n";
import { storedTracks, useOffline } from "@/lib/offline";
import { useNet } from "@/player/net";
import { TrackList } from "@/components/TrackList";

/** True while there is no connection to the server. */
export function useIsOffline(): boolean {
  const online = useOffline((s) => s.online);
  const serverDown = useNet((n) => n.serverDown);
  return !online || serverDown;
}

export function OfflineShelf({ always = false }: { always?: boolean }) {
  const offline = useIsOffline();
  const enabled = useOffline((s) => s.enabled);
  const count = useOffline((s) => s.stored.size);
  const q = useQuery({
    queryKey: ["offline-stored", count],
    queryFn: storedTracks,
    enabled: (offline || always) && enabled && count > 0,
    networkMode: "always",
    staleTime: Infinity,
  });
  if ((!offline && !always) || !enabled || !q.data?.length) return null;
  return (
    <section className="flex flex-col gap-2 px-4 md:px-0">
      <h2 className="text-title-3">{t("ui.offline.storedTitle", { n: q.data.length })}</h2>
      <p className="text-body-sm text-fg-muted">{t("ui.offline.storedHint")}</p>
      <TrackList tracks={q.data} source={{ type: "queue", name: t("ui.offline.storedName") }} selectable={false} />
    </section>
  );
}

export default OfflineShelf;
