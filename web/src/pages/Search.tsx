import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ContextMenu } from "radix-ui";
import { queryClient, useJobs, useWebSearch } from "@/lib/queries";
import { useQuery } from "@tanstack/react-query";
import { playNextWeb, playWeb, queueWeb, usePendingPlay, usePendingQueue } from "@/lib/playweb";
import { Dialog } from "@/components/ui/Dialog";
import { notify, toast } from "@/components/ui/Toast";
import { fmtTime } from "@/lib/format";
import { api, type WebKind, type WebList, type WebResult } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Button, IconButton } from "@/components/ui/Button";
import { Empty, ErrorState } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/AppShell";
import { useLongPress } from "@/components/TrackMenu";
import { useCanHover } from "@/lib/useMedia";
import { t, tn } from "@/i18n";
import { ArtistLinks } from "@/components/ArtistLinks";
import { playWebList } from "@/player/playlistFill";

export function SearchPage() {
  const { q = "" } = useSearch({ from: "/search" });
  const navigate = useNavigate({ from: "/search" });
  const [input, setInput] = useState(q);
  const timer = useRef<number | null>(null);
  useEffect(() => setInput(q), [q]);

  const setQ = (v: string) => navigate({ search: (s) => ({ ...s, q: v || undefined }), replace: true });

  return (
    <div>
      <PageHeader title={t("common.nav.search")}>
        <form
          role="search"
          className="relative mt-4 lg:hidden"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(input);
            (document.activeElement as HTMLElement)?.blur();
          }}
        >
          <Icon name="search" size={20} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            type="search"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (timer.current) clearTimeout(timer.current);
              const v = e.target.value;
              timer.current = window.setTimeout(() => setQ(v), 300);
            }}
            placeholder={t("search.placeholder")}
            aria-label={t("common.nav.search")}
            className="input h-12 w-full pl-10"
            enterKeyHint="search"
          />
        </form>
      </PageHeader>
      {!q.trim() ? (
        <Empty icon="search" title={t("search.empty.title")}>
          {t("search.empty.body")}
        </Empty>
      ) : (
        <WebResults q={q} />
      )}
    </div>
  );
}

type Have = "all" | "have" | "new";

/** Vietnamese-insensitive fold for the "lọc theo tên" box. */
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "");

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full bg-surface-2 p-1">
      {options.map(([k, text]) => (
        <button
          key={k}
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={`focus-ring h-8 rounded-full px-3 text-label transition-colors duration-fast ${value === k ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function WebResults({ q }: { q: string }) {
  const [kind, setKind] = useState<WebKind>("songs");
  const [have, setHave] = useState<Have>("all");
  const [name, setName] = useState("");
  const { data, isLoading, error, refetch } = useWebSearch(q, true, kind);
  const jobs = useJobs();
  useEffect(() => setName(""), [q]);

  const downloaded = (r: WebResult) => {
    if (r.kind === "albums" || r.kind === "playlists") return jobs.data?.jobs.some((j) => j.url.endsWith(`list=${r.id}`) && j.status === "done") ?? false;
    if (r.inLibrary) return true;
    const j = jobs.data?.jobs.find((x) => x.sourceId === r.id);
    return !!j && (j.status === "done" || j.status === "skipped") && !!j.trackId;
  };
  const needle = fold(name.trim());
  const rows = (data?.results ?? []).filter(
    (r) => (have === "all" || (have === "have") === downloaded(r)) && (!needle || fold(`${r.title} ${r.artist ?? r.channel}`).includes(needle)),
  );
  const nHave = (data?.results ?? []).filter(downloaded).length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 md:px-8">
        <Chips
          label={t("search.filter.kindLabel")}
          value={kind}
          onChange={setKind}
          options={[
            ["songs", t("search.kind.songs")],
            ["albums", t("search.kind.albums")],
            ["playlists", t("search.kind.playlists")],
            ["videos", t("search.kind.videos")],
          ]}
        />
        <Chips
          label={t("search.filter.haveLabel")}
          value={have}
          onChange={setHave}
          options={[
            ["all", t("common.all")],
            ["have", data ? t("search.filter.downloadedCount", { count: nHave }) : t("common.downloaded")],
            ["new", t("common.notDownloaded")],
          ]}
        />
        <div className="relative w-full md:w-64">
          <Icon name="filter" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("search.filter.namePlaceholder")} aria-label={t("search.filter.nameAria")} className="input h-10 w-full pl-9 text-body-sm" />
        </div>
      </div>
      <p className="px-4 pb-2 text-caption text-fg-muted md:px-8">{data?.source === "youtube" ? t("search.fallbackYoutube") : HINT[kind]}</p>
      {isLoading ? (
        <div className="flex flex-col items-center gap-2 py-16 text-body-sm text-fg-muted">
          <Icon name="loader" size={28} />
          {t("search.searching")}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !data?.results.length ? (
        <Empty icon="search" title={t("search.noResults")} />
      ) : !rows.length ? (
        <Empty icon="filter" title={t("search.noFilterMatch")} action={<Button onClick={() => (setHave("all"), setName(""))}>{t("search.clearFilter")}</Button>} />
      ) : (
        <ul className="flex flex-col px-2 md:px-6">
          {rows.map((r) => (r.kind === "albums" || r.kind === "playlists" ? <CollectionRow key={r.id} r={r} /> : <WebRow key={r.id} r={r} />))}
        </ul>
      )}
    </div>
  );
}

const HINT: Record<WebKind, string> = {
  songs: t("search.hint.songs"),
  albums: t("search.hint.albums"),
  playlists: t("search.hint.playlists"),
  videos: t("search.hint.videos"),
};

/** Album or playlist: tap to see its songs, play them, or save it as a playlist. */
export function CollectionRow({ r }: { r: WebResult }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button className="focus-ring flex min-h-16 w-full items-center gap-3 rounded-control px-2 py-2 text-left hover:bg-surface-1" onClick={() => setOpen(true)}>
        <img src={r.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-12 shrink-0 rounded-xs bg-surface-3 object-cover md:size-14" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-body-sm md:text-body">
            {r.inLibrary && <Icon name="download-done" size={16} className="mr-1 inline -translate-y-px text-fg-muted" aria-label={t("search.collection.saved")} />}
            {r.title}
          </div>
          <div className="truncate text-caption text-fg-muted">{[r.artist, r.album].filter(Boolean).join(" · ")}</div>
        </div>
        <Icon name="chevron-right" size={20} className="shrink-0 text-fg-muted" />
      </button>
      {open && <CollectionDialog r={r} onClose={() => setOpen(false)} />}
    </li>
  );
}

function CollectionDialog({ r, onClose }: { r: WebResult; onClose: () => void }) {
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["webList", r.id], queryFn: () => api<WebList>(`/api/web/list?id=${encodeURIComponent(r.id)}`), staleTime: 60_000 });
  const [busy, setBusy] = useState<"" | "save" | "play">("");
  const d = list.data;
  // Play: just play it (downloading what is missing), nothing is saved.
  const play = async () => {
    if (!d?.tracks.length) return;
    setBusy("play");
    try {
      const r2 = await playWebList(r.id, r.title, d.tracks);
      if (r2 && r2.downloading > 0) notify({ icon: "download", text: tn("search.collection.playDownloading", r2.downloading) });
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy("");
    }
  };
  const save = async () => {
    setBusy("save");
    try {
      const res = await api<{ playlist: { id: string; name: string }; queued: number; added: number }>("/api/web/list/save", { method: "POST", json: { id: r.id, title: r.title } });
      queryClient.invalidateQueries({ queryKey: ["playlists"] });
      queryClient.invalidateQueries({ queryKey: ["webList", r.id] });
      notify({
        kind: "success",
        title: t("search.collection.savedTitle", { name: res.playlist.name }),
        text: res.queued ? t("search.collection.savedQueued", { n: res.queued }) : t("search.collection.savedAll"),
        action: { label: t("search.collection.open"), onClick: () => navigate({ to: "/playlist/$id", params: { id: res.playlist.id } }) },
      });
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy("");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={r.title} description={[r.artist, r.album].filter(Boolean).join(" · ")}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon="play" loading={busy === "play"} disabled={!d?.tracks.length} onClick={play}>
            {t("search.collection.playAll")}
          </Button>
          {d?.saved ? (
            <Button icon="download-done" onClick={() => navigate({ to: "/playlist/$id", params: { id: d.saved! } })}>
              {t("search.collection.openSaved")}
            </Button>
          ) : (
            <Button icon="playlist-add" loading={busy === "save"} disabled={!d?.tracks.length} onClick={save}>
              {t("search.collection.save")}
            </Button>
          )}
        </div>
        <p className="text-caption text-fg-muted">{t("search.collection.saveHint")}</p>
        {list.isLoading && (
          <div className="flex items-center gap-2 py-6 text-body-sm text-fg-muted">
            <Icon name="loader" size={18} /> {t("search.collection.reading")}
          </div>
        )}
        {list.error && <p className="text-body-sm text-danger">{(list.error as Error).message}</p>}
        <ul className="-mx-2 flex max-h-[55dvh] flex-col overflow-y-auto">
          {d?.tracks.map((tr, i) => <WebRow key={tr.id} r={tr} index={i + 1} />)}
        </ul>
      </div>
    </Dialog>
  );
}

export function WebRow({ r, index }: { r: WebResult; index?: number }) {
  const canHover = useCanHover();
  const jobs = useJobs();
  const pendingJob = usePendingPlay((s) => s.byVideo[r.id]);
  const pendingQueue = usePendingQueue((s) => s.byVideo[r.id]);
  const [busy, setBusy] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const job = jobs.data?.jobs.find((j) => j.sourceId === r.id);
  const active = job && ["queued", "downloading", "processing"].includes(job.status);
  const have = !!r.inLibrary || !!r.onServer || job?.status === "done" || job?.status === "skipped";
  const waiting = !!pendingJob || !!pendingQueue || ((busy || queueBusy) && !have);
  const inLib = r.inLibrary || (job?.status === "done" || job?.status === "skipped" ? job.trackId : "");

  const play = async () => {
    setBusy(true);
    try {
      await playWeb({ ...r, inLibrary: inLib });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const queue = async () => {
    setQueueBusy(true);
    try {
      await queueWeb({ ...r, inLibrary: inLib });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setQueueBusy(false);
    }
  };

  const playNext = async () => {
    setQueueBusy(true);
    try {
      await playNextWeb({ ...r, inLibrary: inLib });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setQueueBusy(false);
    }
  };

  const longPress = useLongPress(() => setSheetOpen(true));

  const rowInner = (
    <div className="flex min-h-16 select-none items-center gap-3 rounded-control px-2 py-2 hover:bg-surface-1">
      {index !== undefined && <span className="w-6 shrink-0 text-right text-caption text-fg-muted tabular">{index}</span>}
      {index === undefined && (
        <img
          src={r.thumbnail}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className={`shrink-0 rounded-xs bg-surface-3 object-cover ${r.kind === "videos" || r.kind === "youtube" ? "h-12 w-20 md:h-14 md:w-24" : "size-12 md:size-14"}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-body-sm md:text-body">{r.title}</div>
        <div className="flex items-center gap-1 truncate text-caption text-fg-muted">
          {have && (
            <Icon
              name="download-done"
              size={14}
              className="shrink-0 text-fg-subtle"
              aria-label={r.inLibrary ? t("search.row.inLibrary") : t("search.row.onServer")}
            />
          )}
          <span className="truncate">
            {r.artist ? <ArtistLinks artist={r.artist} /> : r.channel}
            {[index === undefined ? r.album : "", r.duration > 0 ? fmtTime(r.duration) : ""]
              .filter(Boolean)
              .map((x) => " · " + x)
              .join("")}
          </span>
        </div>
      </div>
      {active && waiting ? (
        <span className="flex h-10 items-center gap-2 px-2 text-caption text-fg-muted" aria-live="polite">
          <Icon name="loader" size={18} />
          {job!.status === "downloading" && job!.progress > 0 ? `${Math.round(job!.progress * 100)}%` : t("search.row.preparing")}
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={queueBusy ? "loader" : "queue"}
            size={20}
            label={t("tracks.action.addToQueue")}
            disabled={busy || queueBusy}
            onClick={(e) => {
              e.stopPropagation();
              void queue();
            }}
            className="!size-10"
          />
          <button
            onClick={play}
            disabled={busy || queueBusy}
            className={`focus-ring flex size-10 shrink-0 items-center justify-center rounded-full transition-colors ${have ? "bg-accent text-fg-on-accent" : "bg-surface-2 text-fg hover:bg-surface-3"} ${job?.status === "error" ? "!text-danger" : ""}`}
            aria-label={have ? t("search.row.playAria", { title: r.title }) : t("search.row.downloadPlayAria", { title: r.title })}
            title={have ? undefined : t("search.row.downloadPlayHint")}
          >
            <Icon name={busy ? "loader" : job?.status === "error" ? "retry" : "play"} size={20} />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <li>
      <div className="contents" {...longPress}>
        {canHover ? (
          <ContextMenu.Root modal={false}>
            <ContextMenu.Trigger asChild>{rowInner}</ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className="menu-content">
                <ContextMenu.Item className="menu-item" onSelect={() => void play()}>
                  <Icon name="play" size={20} className="text-fg-muted" />
                  {t("common.play")}
                </ContextMenu.Item>
                <ContextMenu.Item className="menu-item" onSelect={() => void playNext()}>
                  <Icon name="queue" size={20} className="text-fg-muted" />
                  {t("tracks.action.playNext")}
                </ContextMenu.Item>
                <ContextMenu.Item className="menu-item" onSelect={() => void queue()}>
                  <Icon name="plus" size={20} className="text-fg-muted" />
                  {t("tracks.action.addToQueue")}
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        ) : (
          rowInner
        )}
      </div>
      {sheetOpen && (
        <Dialog open onOpenChange={(o) => !o && setSheetOpen(false)} title={r.title} description={r.artist || r.channel || undefined}>
          <div className="-mx-4 -mt-2 flex flex-col">
            <button
              onClick={() => {
                setSheetOpen(false);
                void play();
              }}
              className="focus-ring state-layer flex h-14 items-center gap-4 rounded-control px-4 text-left text-body"
            >
              <Icon name="play" className="text-fg-muted" />
              {t("common.play")}
            </button>
            <button
              onClick={() => {
                setSheetOpen(false);
                void playNext();
              }}
              className="focus-ring state-layer flex h-14 items-center gap-4 rounded-control px-4 text-left text-body"
            >
              <Icon name="queue" className="text-fg-muted" />
              {t("tracks.action.playNext")}
            </button>
            <button
              onClick={() => {
                setSheetOpen(false);
                void queue();
              }}
              className="focus-ring state-layer flex h-14 items-center gap-4 rounded-control px-4 text-left text-body"
            >
              <Icon name="plus" className="text-fg-muted" />
              {t("tracks.action.addToQueue")}
            </button>
          </div>
        </Dialog>
      )}
    </li>
  );
}
