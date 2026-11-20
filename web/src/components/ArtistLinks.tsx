import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { usePlayer } from "@/player/store";
import { t } from "@/i18n";

// Same separators as the server (internal/server/external.go artistSplitRe).
const SPLIT = /\s*(?:,|&|\/|;|\bft\.?|\bfeat\.?|\bfeaturing\b|\sx\s|\swith\s)\s*/i;

export function splitArtists(s: string): string[] {
  return s
    .split(SPLIT)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** A mouse (or trackpad) is there: small inline links can be hit precisely. */
const finePointer = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;

/**
 * "Rhymastic, SOOBIN, Binz" as three links to each artist's page. Clicks don't
 * reach the row underneath (play / jump), and close the full-screen player.
 * On touch screens the names are plain text (a tap on a row would too often
 * land on a name), unless `touch` is set for a large standalone line.
 */
export function ArtistLinks({
  artist,
  className = "",
  linkClassName = "hover:text-fg hover:underline",
  touch = false,
}: {
  artist: string;
  className?: string;
  linkClassName?: string;
  touch?: boolean;
}) {
  const names = splitArtists(artist || "");
  if (!names.length) return <span className={className}>{t("common.unknownArtist")}</span>;
  if (!finePointer && !touch) return <span className={className}>{names.join(", ")}</span>;
  return (
    <span className={className}>
      {names.map((name, i) => (
        <Fragment key={name + i}>
          {i > 0 && ", "}
          <Link
            to="/artist/$name"
            params={{ name }}
            className={`focus-ring rounded-xs ${linkClassName}`}
            onClick={(e) => {
              e.stopPropagation();
              const p = usePlayer.getState();
              if (p.npOpen) p.setNp(false);
              if (p.lyricsFull) p.setLyricsFull(false);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {name}
          </Link>
        </Fragment>
      ))}
    </span>
  );
}
