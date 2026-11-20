import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { DropdownMenu } from "radix-ui";
import { useAlbums, useArtists, usePlaylists, useTracks, type TrackSort } from "@/lib/queries";
import { usePlayer } from "@/player/store";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Empty, ErrorState, Spinner } from "@/components/ui/misc";
import { AlbumCard, ArtistCard, PlaylistCard } from "@/components/Cards";
import { TrackList } from "@/components/TrackList";
import { PageHeader } from "@/components/layout/AppShell";
import { openDialog } from "@/components/dialogs";
import { useIsMobile } from "@/lib/useMedia";
import { locale, t, tn } from "@/i18n";

export type LibTab = "songs" | "artists" | "albums" | "playlists";
const tabs: [LibTab, string][] = [
  ["songs", t("library.tabs.songs")],
  ["artists", t("library.tabs.artists")],
  ["albums", t("library.tabs.albums")],
  ["playlists", t("library.tabs.playlists")],
];
const sorts: [TrackSort, string][] = [
  ["added", t("library.sort.added")],
  ["title", t("library.sort.title")],
  ["artist", t("library.sort.artist")],
  ["plays", t("library.sort.plays")],
];

export function LibraryPage() {
  const { tab = "songs", sort = "added" } = useSearch({ from: "/library" });
  const navigate = useNavigate({ from: "/library" });
  return (
    <div>
      <PageHeader title={t("common.nav.library")}>
        <div role="tablist" className="no-scrollbar -mx-4 mt-4 flex gap-2 overflow-x-auto px-4">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => navigate({ search: (s) => ({ ...s, tab: k }), replace: true })}
              className={`focus-ring h-9 shrink-0 rounded-full px-4 text-label transition-colors duration-fast ${tab === k ? "bg-fg text-canvas" : "bg-surface-2 text-fg state-layer"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </PageHeader>
      {tab === "songs" && <Songs sort={sort} onSort={(s) => navigate({ search: (p) => ({ ...p, sort: s }), replace: true })} />}
      {tab === "artists" && <Artists />}
      {tab === "albums" && <Albums />}
      {tab === "playlists" && <Playlists />}
    </div>
  );
}

const grid = "grid grid-cols-2 gap-4 px-4 md:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] md:px-6 lg:grid-cols-[repeat(auto-fill,minmax(176px,1fr))]";

function Songs({ sort, onSort }: { sort: TrackSort; onSort: (s: TrackSort) => void }) {
  const { data: all, isLoading, error, refetch } = useTracks(sort);
  const mobile = useIsMobile();
  const [langFilter, setLangFilter] = useState("");
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!all?.length)
    return (
      <Empty icon="music-note" title={t("library.empty.songsTitle")} action={<Link to="/downloads" className="focus-ring inline-flex h-11 items-center gap-2 rounded-control bg-accent px-4 text-label text-fg-on-accent"><Icon name="download" size={20} />{t("library.empty.downloadMusic")}</Link>}>
        {t("library.empty.songsBody")}
      </Empty>
    );
  // Songs by language (Việt, Âu Mỹ, Nhật…): pick one to keep a session in one language.
  const langs = [...new Set(all.map((x) => x.lang || ""))].filter(Boolean);
  const data = langFilter ? all.filter((x) => x.lang === langFilter) : all;
  const source = { type: "library" as const, id: `all:${sort}:${langFilter}`, name: langFilter ? `${t("common.nav.library")} · ${t(`common.lang.${langFilter}`)}` : t("common.nav.library") };
  return (
    <div className="md:px-6">
      {langs.length > 1 && (
        <div role="radiogroup" aria-label={t("library.langFilter")} className="mb-3 flex flex-wrap gap-2 px-4 md:px-0">
          {["", ...langs].map((l) => (
            <button
              key={l || "all"}
              role="radio"
              aria-checked={langFilter === l}
              onClick={() => setLangFilter(l)}
              className={`focus-ring h-8 rounded-full px-3 text-label ${langFilter === l ? "bg-fg text-canvas" : "bg-surface-2 text-fg hover:bg-surface-3"}`}
            >
              {l ? t(`common.lang.${l}`) : t("common.all")}
            </button>
          ))}
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2 px-4 md:px-0">
        <Button variant="primary" icon="play" onClick={() => usePlayer.getState().playList(data, 0, source, { shuffle: false })}>
          {t("common.play")}
        </Button>
        <Button icon="shuffle" onClick={() => usePlayer.getState().playList(data, -1, source, { shuffle: true })}>
          {t("common.shuffle")}
        </Button>
        <span className="ml-1 text-body-sm text-fg-muted">{tn("common.songs", data.length, { n: data.length.toLocaleString(locale()) })}</span>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button className="focus-ring state-layer ml-auto inline-flex h-9 items-center gap-1 rounded-control px-3 text-label text-fg-muted">
              <Icon name="sort" size={18} />
              {sorts.find((s) => s[0] === sort)?.[1]}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="menu-content">
              <DropdownMenu.RadioGroup value={sort} onValueChange={(v) => onSort(v as TrackSort)}>
                {sorts.map(([k, label]) => (
                  <DropdownMenu.RadioItem key={k} value={k} className="menu-item">
                    <span className="w-5">
                      <DropdownMenu.ItemIndicator>
                        <Icon name="check" size={18} className="text-accent" />
                      </DropdownMenu.ItemIndicator>
                    </span>
                    {label}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <p className="mb-2 px-4 text-caption text-fg-subtle md:px-0">
        {mobile ? t("library.hint.mobile") : t("library.hint.desktop")}
      </p>
      <div className="px-2 md:px-0">
        <TrackList tracks={data} source={source} showAdded={sort === "added"} />
      </div>
    </div>
  );
}

function Artists() {
  const { data, isLoading, error, refetch } = useArtists();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data?.length) return <Empty icon="artist" title={t("library.empty.artistsTitle")} />;
  return (
    <div className={grid}>
      {data.map((a) => (
        <ArtistCard key={a.name} artist={a} />
      ))}
    </div>
  );
}

function Albums() {
  const { data, isLoading, error, refetch } = useAlbums();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data?.length)
    return (
      <Empty icon="album" title={t("library.empty.albumsTitle")}>
        {t("library.empty.albumsBody")}
      </Empty>
    );
  return (
    <div className={grid}>
      {data.map((a) => (
        <AlbumCard key={a.artist + "\u0000" + a.name} album={a} />
      ))}
    </div>
  );
}

function Playlists() {
  const { data, isLoading, error, refetch } = usePlaylists();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div>
      <div className="mb-4 flex gap-2 px-4 md:px-6">
        <Button icon="plus" onClick={() => openDialog({ kind: "newPlaylist" })}>
          {t("library.playlists.new")}
        </Button>
        <Button icon="mix" variant="ghost" onClick={() => openDialog({ kind: "newPlaylist", smart: true })}>
          {t("library.playlists.smart")}
        </Button>
      </div>
      <div className={grid}>
        {data?.map((p) => (
          <PlaylistCard key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}
