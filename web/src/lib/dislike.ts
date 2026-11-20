// "Không thích bài này" / "Không thích nghệ sĩ này": never suggested again
// (radio, autoplay, mixes, auto-download), and dropped from the queue at once.
import { useQuery } from "@tanstack/react-query";
import { api, type Track } from "./api";
import { queryClient, sendFeedback } from "./queries";
import { notify } from "@/components/ui/Toast";
import { usePlayer } from "@/player/store";
import { engine } from "@/player/engine";
import { followKey } from "./follows";
import { t } from "@/i18n";

export type Disliked = { kind: "artist" | "track"; key: string; name: string; artist?: string; at: number };

export const useDisliked = () => useQuery({ queryKey: ["disliked"], queryFn: () => api<Disliked[]>("/api/feedback") });

// Same separators as the server (internal/server/external.go artistSplitRe) and ArtistLinks.
const SPLIT = /\s*(?:,|&|\/|;|\bft\.?|\bfeat\.?|\bfeaturing\b|\sx\s|\swith\s)\s*/i;
const artistsOf = (s: string) => s.split(SPLIT).map((a) => a.trim()).filter(Boolean);

/** Take matching songs out of what is still to come; skip the current one if it matches. */
function dropFromQueue(match: (t: Track) => boolean) {
  const p = usePlayer.getState();
  const upcoming = [...p.manual, ...p.context.slice(p.pos + 1)];
  for (const e of upcoming) if (match(e.track)) usePlayer.getState().removeUpcoming(e.uid);
  const cur = usePlayer.getState().current;
  if (cur && match(cur.track)) engine.next();
}

function refresh() {
  for (const k of ["disliked", "home", "foryou", "discover"]) queryClient.invalidateQueries({ queryKey: [k] });
}

export async function dislikeTrack(track: Track) {
  await sendFeedback("track", track.id, -1);
  dropFromQueue((t) => t.id === track.id);
  refresh();
  notify({
    icon: "close",
    text: t("tracks.toast.dislikedTrack", { title: track.title }),
    action: { label: t("common.undo"), onClick: () => void undoDislike("track", track.id) },
  });
}

export async function dislikeArtist(name: string) {
  await sendFeedback("artist", name, -1);
  const k = followKey(name);
  dropFromQueue((t) => artistsOf(t.artist).some((a) => followKey(a) === k));
  refresh();
  notify({
    icon: "close",
    text: t("tracks.toast.dislikedArtist", { name }),
    action: { label: t("common.undo"), onClick: () => void undoDislike("artist", name) },
  });
}

export async function undoDislike(kind: "artist" | "track", key: string) {
  await sendFeedback(kind, key, 0);
  refresh();
}

/** The first credited artist ("Đạt G" of "Đạt G, Du Uyên"). */
export const mainArtist = (artist: string) => artistsOf(artist)[0] ?? artist;
