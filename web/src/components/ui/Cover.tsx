import { useState } from "react";
import { coverUrl } from "@/lib/api";
import { Icon } from "./Icon";

type Props = { trackId?: string | null; hasCover?: boolean; size?: number | string; className?: string; rounded?: string; alt?: string; eager?: boolean };

/** Album art with a neutral placeholder; size is a px number or any CSS length. */
export function Cover({ trackId, hasCover = true, size = 48, className = "", rounded = "rounded-xs", alt = "", eager }: Props) {
  const [failed, setFailed] = useState<string | null>(null);
  const dim = typeof size === "number" ? `${size}px` : size;
  const show = trackId && hasCover && failed !== trackId;
  return (
    <div className={`relative shrink-0 overflow-hidden bg-surface-3 ${rounded} ${className}`} style={{ width: dim, height: dim }}>
      {show ? (
        <img
          key={trackId}
          src={coverUrl(trackId)}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={() => setFailed(trackId)}
          className="size-full object-cover"
        />
      ) : (
        <div className="flex size-full items-center justify-center text-fg-subtle">
          <Icon name="music-note" size={typeof size === "number" ? Math.max(16, Math.min(64, Math.round(size * 0.4))) : 40} />
        </div>
      )}
    </div>
  );
}

/** 2×2 collage of covers for playlists and mixes. */
export function Collage({ ids, size = 160, className = "", rounded = "rounded-card" }: { ids: string[]; size?: number | string; className?: string; rounded?: string }) {
  const dim = typeof size === "number" ? `${size}px` : size;
  if (ids.length < 4) return <Cover trackId={ids[0]} hasCover={ids.length > 0} size={size} rounded={rounded} className={className} />;
  return (
    <div className={`relative grid shrink-0 grid-cols-2 overflow-hidden bg-surface-3 ${rounded} ${className}`} style={{ width: dim, height: dim }}>
      {ids.slice(0, 4).map((id) => (
        <img key={id} src={coverUrl(id)} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
      ))}
    </div>
  );
}
