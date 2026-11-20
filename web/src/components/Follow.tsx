import { Link } from "@tanstack/react-router";
import { useIsFollowing, useToggleFollow, type FollowedArtist } from "@/lib/follows";
import { useIsMobile } from "@/lib/useMedia";
import { Button } from "./ui/Button";
import { Cover } from "./ui/Cover";
import { Icon } from "./ui/Icon";
import { t, tn } from "@/i18n";

/** Theo dõi / Đang theo dõi on an artist page. */
export function FollowButton({ name, image }: { name: string; image?: string }) {
  const following = useIsFollowing(name);
  const toggle = useToggleFollow();
  const mobile = useIsMobile();
  return (
    <Button
      variant={following ? "secondary" : "primary"}
      size={mobile ? "sm" : "md"}
      icon={following ? "check" : "plus"}
      aria-pressed={following}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate({ name, image, follow: !following })}
    >
      {following ? t("ui.follow.following") : t("ui.follow.follow")}
    </Button>
  );
}

/** Round picture: a library cover, else the YouTube Music picture, else an icon. */
export function ArtistAvatar({ a, size }: { a: Pick<FollowedArtist, "coverTrackId" | "image">; size: number | string }) {
  if (a.coverTrackId) return <Cover trackId={a.coverTrackId} hasCover size={size} rounded="rounded-full" />;
  const dim = typeof size === "number" ? `${size}px` : size;
  if (a.image)
    return (
      <img
        src={a.image}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{ width: dim, height: dim }}
        className="shrink-0 rounded-full bg-surface-3 object-cover"
      />
    );
  return (
    <span style={{ width: dim, height: dim }} className="flex shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-muted">
      <Icon name="artist" size={20} />
    </span>
  );
}

/** A followed artist in the sidebar. */
export function FollowedRow({ a, active }: { a: FollowedArtist; active: boolean }) {
  return (
    <Link
      to="/artist/$name"
      params={{ name: a.name }}
      aria-current={active ? "page" : undefined}
      className={`focus-ring state-layer flex h-14 w-full items-center gap-3 rounded-control px-2 text-left ${active ? "bg-surface-2" : ""}`}
    >
      <ArtistAvatar a={a} size={40} />
      <span className="min-w-0">
        <span className="block truncate text-label">{a.name}</span>
        <span className="block truncate text-caption text-fg-muted">
          {a.trackCount ? tn("common.songs", a.trackCount) : t("ui.follow.artist")}
        </span>
      </span>
    </Link>
  );
}

/** A followed artist as a card (library → Nghệ sĩ, mainly for mobile). */
export function FollowedCard({ a }: { a: FollowedArtist }) {
  return (
    <Link
      to="/artist/$name"
      params={{ name: a.name }}
      className="focus-ring state-layer flex w-24 shrink-0 flex-col items-center gap-2 rounded-card p-1 text-center"
    >
      <ArtistAvatar a={a} size={80} />
      <span className="w-full truncate text-label">{a.name}</span>
    </Link>
  );
}
