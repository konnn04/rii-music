import { useMemo, useState } from "react";
import { Popover } from "radix-ui";
import type { Track } from "@/lib/api";
import { Icon, type IconName } from "@/components/ui/Icon";
import { locale, t } from "@/i18n";

export type PlayFilter = "" | "unplayed" | "played" | "frequent";
export type AddedFilter = "" | "7d" | "30d" | "90d";
export type DurationFilter = "" | "short" | "medium" | "long";

export type LibraryFilter = {
  query: string;
  langs: string[];
  artist: string;
  album: string;
  liked: boolean;
  plays: PlayFilter;
  added: AddedFilter;
  duration: DurationFilter;
};

export const emptyFilter: LibraryFilter = {
  query: "",
  langs: [],
  artist: "",
  album: "",
  liked: false,
  plays: "",
  added: "",
  duration: "",
};

const DAY_MS = 86_400_000;

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

export function applyFilter(tracks: Track[], f: LibraryFilter): Track[] {
  const q = fold(f.query.trim());
  const now = f.added ? Date.now() : 0;
  const minAdded =
    f.added === "7d"
      ? now - 7 * DAY_MS
      : f.added === "30d"
        ? now - 30 * DAY_MS
        : f.added === "90d"
          ? now - 90 * DAY_MS
          : 0;

  return tracks.filter((tr) => {
    if (q) {
      if (!fold(tr.title).includes(q) && !fold(tr.artist).includes(q) && !fold(tr.album).includes(q)) {
        return false;
      }
    }
    if (f.langs.length > 0 && (!tr.lang || !f.langs.includes(tr.lang))) return false;
    if (f.artist && tr.artist !== f.artist) return false;
    if (f.album && tr.album !== f.album) return false;
    if (f.liked && !tr.liked) return false;
    if (f.plays === "unplayed" && tr.playCount !== 0) return false;
    if (f.plays === "played" && tr.playCount <= 0) return false;
    if (f.plays === "frequent" && tr.playCount < 5) return false;
    if (minAdded > 0 && tr.addedAt < minAdded) return false;
    if (f.duration === "short" && tr.durationMs >= 180_000) return false;
    if (f.duration === "medium" && (tr.durationMs < 180_000 || tr.durationMs > 300_000)) return false;
    if (f.duration === "long" && tr.durationMs <= 300_000) return false;
    return true;
  });
}

export function activeCount(f: LibraryFilter): number {
  return (
    (f.query.trim() ? 1 : 0) +
    f.langs.length +
    (f.artist ? 1 : 0) +
    (f.album ? 1 : 0) +
    (f.liked ? 1 : 0) +
    (f.plays ? 1 : 0) +
    (f.added ? 1 : 0) +
    (f.duration ? 1 : 0)
  );
}

const playOptions: [PlayFilter, string][] = [
  ["", "common.all"],
  ["unplayed", "library.filter.plays.unplayed"],
  ["played", "library.filter.plays.played"],
  ["frequent", "library.filter.plays.frequent"],
];

const addedOptions: [AddedFilter, string][] = [
  ["", "common.all"],
  ["7d", "library.filter.added.7d"],
  ["30d", "library.filter.added.30d"],
  ["90d", "library.filter.added.90d"],
];

const durationOptions: [DurationFilter, string][] = [
  ["", "common.all"],
  ["short", "library.filter.duration.short"],
  ["medium", "library.filter.duration.medium"],
  ["long", "library.filter.duration.long"],
];

type Chip = { key: string; label: string; icon?: IconName; onRemove: () => void };

export function LibraryFilterBar({
  tracks,
  value,
  onChange,
}: {
  tracks: Track[];
  value: LibraryFilter;
  onChange: (next: LibraryFilter) => void;
}) {
  const [artistQuery, setArtistQuery] = useState("");
  const [albumQuery, setAlbumQuery] = useState("");

  const { langs, artists, albums } = useMemo(() => {
    const langSet = new Set<string>();
    const artistSet = new Set<string>();
    const albumSet = new Set<string>();
    for (const tr of tracks) {
      if (tr.lang) langSet.add(tr.lang);
      if (tr.artist) artistSet.add(tr.artist);
      if (tr.album) albumSet.add(tr.album);
    }
    const loc = locale();
    return {
      langs: [...langSet],
      artists: [...artistSet].sort((a, b) => a.localeCompare(b, loc)),
      albums: [...albumSet].sort((a, b) => a.localeCompare(b, loc)),
    };
  }, [tracks]);

  const visibleArtists = useMemo(() => {
    const q = fold(artistQuery.trim());
    if (!q) return artists;
    return artists.filter((a) => fold(a).includes(q));
  }, [artists, artistQuery]);

  const visibleAlbums = useMemo(() => {
    const q = fold(albumQuery.trim());
    if (!q) return albums;
    return albums.filter((a) => fold(a).includes(q));
  }, [albums, albumQuery]);

  const menuCount = activeCount({ ...value, query: "" });

  const toggleLang = (code: string) => {
    const exists = value.langs.includes(code);
    onChange({
      ...value,
      langs: exists ? value.langs.filter((l) => l !== code) : [...value.langs, code],
    });
  };

  const chips: Chip[] = [];
  for (const code of value.langs) {
    chips.push({
      key: `lang:${code}`,
      label: t(`common.lang.${code}`),
      icon: "globe",
      onRemove: () => onChange({ ...value, langs: value.langs.filter((l) => l !== code) }),
    });
  }
  if (value.artist) {
    chips.push({
      key: "artist",
      label: value.artist,
      icon: "artist",
      onRemove: () => onChange({ ...value, artist: "" }),
    });
  }
  if (value.album) {
    chips.push({
      key: "album",
      label: value.album,
      icon: "album",
      onRemove: () => onChange({ ...value, album: "" }),
    });
  }
  if (value.liked) {
    chips.push({
      key: "liked",
      label: t("library.filter.likedOnly"),
      icon: "heart-filled",
      onRemove: () => onChange({ ...value, liked: false }),
    });
  }
  if (value.plays) {
    chips.push({
      key: "plays",
      label: t(`library.filter.plays.${value.plays}`),
      onRemove: () => onChange({ ...value, plays: "" }),
    });
  }
  if (value.added) {
    chips.push({
      key: "added",
      label: t(`library.filter.added.${value.added}`),
      icon: "history",
      onRemove: () => onChange({ ...value, added: "" }),
    });
  }
  if (value.duration) {
    chips.push({
      key: "duration",
      label: t(`library.filter.duration.${value.duration}`),
      onRemove: () => onChange({ ...value, duration: "" }),
    });
  }

  return (
    <div className="mb-3 space-y-2 px-4 md:px-0">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-muted"
          />
          <input
            type="text"
            value={value.query}
            onChange={(e) => onChange({ ...value, query: e.target.value })}
            placeholder={t("library.filter.searchPlaceholder")}
            aria-label={t("library.filter.searchPlaceholder")}
            className="input h-10 w-full pr-9 pl-9 text-body-sm"
          />
          {value.query && (
            <button
              type="button"
              onClick={() => onChange({ ...value, query: "" })}
              aria-label={t("library.filter.clearSearch")}
              className="focus-ring absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-fg-muted hover:text-fg"
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </div>

        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={t("library.filter.button")}
              className={`focus-ring state-layer relative inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-control px-3 text-label transition-colors duration-fast ${
                menuCount > 0 ? "bg-accent text-fg-on-accent" : "bg-surface-2 text-fg"
              }`}
            >
              <Icon name="filter" size={18} />
              <span className="hidden sm:inline">{t("library.filter.button")}</span>
              {menuCount > 0 && (
                <span
                  className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-caption font-semibold ${
                    menuCount > 0 ? "bg-canvas/20 text-fg-on-accent" : ""
                  }`}
                >
                  {menuCount}
                </span>
              )}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              className="menu-content w-[min(340px,calc(100vw-2rem))] max-h-[75vh] space-y-3.5 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-label font-semibold text-fg">{t("library.filter.button")}</span>
                {menuCount > 0 && (
                  <button
                    type="button"
                    onClick={() => onChange({ ...emptyFilter, query: value.query })}
                    className="focus-ring rounded px-1.5 py-0.5 text-caption font-medium text-accent hover:underline"
                  >
                    {t("library.filter.clear")}
                  </button>
                )}
              </div>

              <button
                type="button"
                aria-pressed={value.liked}
                onClick={() => onChange({ ...value, liked: !value.liked })}
                className={`focus-ring flex w-full items-center justify-between rounded-control px-3 py-2 text-body-sm transition-colors duration-fast ${
                  value.liked ? "bg-accent/15 text-accent" : "bg-surface-2 text-fg hover:bg-surface-4"
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <Icon name={value.liked ? "heart-filled" : "heart"} size={18} />
                  {t("library.filter.likedOnly")}
                </span>
                {value.liked && <Icon name="check" size={16} />}
              </button>

              {langs.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-caption font-medium text-fg-muted">{t("library.filter.lang")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {langs.map((code) => {
                      const active = value.langs.includes(code);
                      return (
                        <button
                          key={code}
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggleLang(code)}
                          className={`focus-ring h-7 rounded-full px-2.5 text-caption transition-colors duration-fast ${
                            active ? "bg-fg text-canvas" : "bg-surface-2 text-fg hover:bg-surface-4"
                          }`}
                        >
                          {t(`common.lang.${code}`)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <div className="text-caption font-medium text-fg-muted">{t("library.filter.playsLabel")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {playOptions.map(([k, labelKey]) => {
                    const active = value.plays === k;
                    return (
                      <button
                        key={k || "any"}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange({ ...value, plays: k })}
                        className={`focus-ring h-7 rounded-full px-2.5 text-caption transition-colors duration-fast ${
                          active ? "bg-fg text-canvas" : "bg-surface-2 text-fg hover:bg-surface-4"
                        }`}
                      >
                        {t(labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-caption font-medium text-fg-muted">{t("library.filter.addedLabel")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {addedOptions.map(([k, labelKey]) => {
                    const active = value.added === k;
                    return (
                      <button
                        key={k || "any"}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange({ ...value, added: k })}
                        className={`focus-ring h-7 rounded-full px-2.5 text-caption transition-colors duration-fast ${
                          active ? "bg-fg text-canvas" : "bg-surface-2 text-fg hover:bg-surface-4"
                        }`}
                      >
                        {t(labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-caption font-medium text-fg-muted">{t("library.filter.durationLabel")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {durationOptions.map(([k, labelKey]) => {
                    const active = value.duration === k;
                    return (
                      <button
                        key={k || "any"}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange({ ...value, duration: k })}
                        className={`focus-ring h-7 rounded-full px-2.5 text-caption transition-colors duration-fast ${
                          active ? "bg-fg text-canvas" : "bg-surface-2 text-fg hover:bg-surface-4"
                        }`}
                      >
                        {t(labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {artists.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-caption font-medium text-fg-muted">{t("library.filter.artist")}</div>
                  {artists.length > 12 && (
                    <input
                      type="text"
                      value={artistQuery}
                      onChange={(e) => setArtistQuery(e.target.value)}
                      placeholder={t("library.filter.searchArtist")}
                      aria-label={t("library.filter.searchArtist")}
                      className="input h-8 w-full px-2.5 text-caption"
                    />
                  )}
                  <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-control bg-surface-2 p-1">
                    {visibleArtists.map((name) => {
                      const active = value.artist === name;
                      return (
                        <button
                          key={name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => onChange({ ...value, artist: active ? "" : name })}
                          className={`menu-item h-8 w-full justify-between px-2 text-caption ${
                            active ? "bg-surface-4 font-medium text-accent" : "hover:bg-surface-4/60"
                          }`}
                        >
                          <span className="truncate">{name}</span>
                          {active && <Icon name="check" size={14} className="shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {albums.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-caption font-medium text-fg-muted">{t("library.filter.album")}</div>
                  {albums.length > 12 && (
                    <input
                      type="text"
                      value={albumQuery}
                      onChange={(e) => setAlbumQuery(e.target.value)}
                      placeholder={t("library.filter.searchAlbum")}
                      aria-label={t("library.filter.searchAlbum")}
                      className="input h-8 w-full px-2.5 text-caption"
                    />
                  )}
                  <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-control bg-surface-2 p-1">
                    {visibleAlbums.map((name) => {
                      const active = value.album === name;
                      return (
                        <button
                          key={name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => onChange({ ...value, album: active ? "" : name })}
                          className={`menu-item h-8 w-full justify-between px-2 text-caption ${
                            active ? "bg-surface-4 font-medium text-accent" : "hover:bg-surface-4/60"
                          }`}
                        >
                          <span className="truncate">{name}</span>
                          {active && <Icon name="check" size={14} className="shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.onRemove}
              aria-label={t("library.filter.removeChip", { label: c.label })}
              className="focus-ring inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-surface-2 px-2.5 text-caption text-fg transition-colors duration-fast hover:bg-surface-4"
            >
              {c.icon && <Icon name={c.icon} size={14} className="text-fg-muted" />}
              <span className="truncate">{c.label}</span>
              <Icon name="close" size={13} className="text-fg-muted" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange(emptyFilter)}
            className="focus-ring rounded px-1.5 py-0.5 text-caption font-medium text-accent hover:underline"
          >
            {t("library.filter.clear")}
          </button>
        </div>
      )}
    </div>
  );
}
