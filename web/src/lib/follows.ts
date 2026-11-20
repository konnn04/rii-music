// Followed artists: the sidebar list, the Theo dõi button on artist pages.
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { queryClient } from "./queries";
import { toast } from "@/components/ui/Toast";
import { t } from "@/i18n";

export type FollowedArtist = {
  key: string;
  name: string;
  image?: string;
  coverTrackId?: string;
  trackCount: number;
  followedAt: number;
};

/** Mirrors the server's followKey: accents, case and punctuation folded. */
export function followKey(name: string): string {
  const folded = name
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .normalize("NFC");
  const loose = folded.replace(/[^a-z0-9]+/g, "");
  return loose || name.toLowerCase().split(/\s+/).join("");
}

export const useFollows = () => useQuery({ queryKey: ["follows"], queryFn: () => api<FollowedArtist[]>("/api/follows") });

export function useIsFollowing(name: string): boolean {
  const { data } = useFollows();
  const k = followKey(name);
  return !!data?.some((f) => f.key === k);
}

function refresh() {
  queryClient.invalidateQueries({ queryKey: ["follows"] });
  for (const k of ["home", "foryou", "discover"]) queryClient.invalidateQueries({ queryKey: [k] });
}

export function useToggleFollow() {
  return useMutation({
    mutationFn: ({ name, image, follow }: { name: string; image?: string; follow: boolean }) =>
      follow
        ? api("/api/follows", { method: "PUT", json: { name, image: image ?? "" } })
        : api(`/api/follows?name=${encodeURIComponent(name)}`, { method: "DELETE" }),
    onMutate: ({ name, image, follow }) => {
      // Instant feedback in the button and the sidebar.
      const k = followKey(name);
      queryClient.setQueryData<FollowedArtist[]>(["follows"], (old = []) =>
        follow
          ? old.some((f) => f.key === k)
            ? old
            : [{ key: k, name, image, trackCount: 0, followedAt: Date.now() }, ...old]
          : old.filter((f) => f.key !== k),
      );
    },
    onSuccess: (_, { name, follow }) => {
      toast(follow ? t("ui.follow.followed", { name }) : t("ui.follow.unfollowed", { name }), follow ? "success" : undefined);
      refresh();
    },
    onError: (e: Error) => {
      toast(e.message || t("common.error"), "error");
      refresh();
    },
  });
}
