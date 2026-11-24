import { joinRoom } from "@/player/room";
import { playTrackId } from "@/lib/playweb";
import { toast } from "@/components/ui/Toast";
import { t } from "@/i18n";

/** Handle ?room=<code> and ?track=<id> deep-link query params after sign-in. */
export function handleDeepLink(): void {
  const params = new URLSearchParams(location.search);
  const room = params.get("room")?.trim();
  const track = params.get("track")?.trim();
  if (!room && !track) return;

  params.delete("room");
  params.delete("track");
  const nextSearch = params.toString();
  const nextUrl = location.pathname + (nextSearch ? `?${nextSearch}` : "") + location.hash;
  history.replaceState(history.state, "", nextUrl);

  const onError = (err: unknown) => {
    const msg = err instanceof Error && err.message ? err.message : t("common.error");
    toast(msg, "error");
  };

  if (room) {
    void joinRoom(room).catch(onError);
  } else if (track) {
    void playTrackId(track).catch(onError);
  }
}
