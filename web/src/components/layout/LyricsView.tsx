import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Lyrics } from "@/lib/api";
import { queryClient, useLyrics } from "@/lib/queries";
import { engine } from "@/player/engine";
import { usePlayback, usePlayer } from "@/player/store";
import { fmtTime } from "@/lib/format";
import { t } from "@/i18n";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/Toast";

type Line = { t: number; text: string };

export function parseLRC(lrc: string): Line[] {
  const out: Line[] = [];
  let offset = 0;
  for (const raw of lrc.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) offset = parseInt(off[1], 10) / 1000;
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
      out.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac - offset, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function activeIndex(lines: Line[], at: number) {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= at + 0.15) active = i;
    else break;
  }
  return active;
}

/** The synced line playing now (for the cover view), or null. */
export function useLyricLine(): string | null {
  const track = usePlayer((s) => s.current?.track);
  const { data } = useLyrics(track?.id);
  const lines = useMemo(() => (data?.synced ? parseLRC(data.synced) : []), [data?.synced]);
  const position = usePlayback((s) => s.position);
  if (!lines.length) return null;
  const i = activeIndex(lines, position + (data?.offsetMs ?? 0) / 1000);
  return i >= 0 ? lines[i].text || "♪" : null;
}

type Tab = "offset" | "search" | "paste";

/** Synced lyrics: current line bright, others dim; auto-scroll; tap a line to seek there. */
export function LyricsView({ size = "md", className = "" }: { size?: "md" | "lg"; className?: string }) {
  const track = usePlayer((s) => s.current?.track);
  const { data, isLoading, isError, refetch } = useLyrics(track?.id);
  const [tools, setTools] = useState<Tab | null>(null);

  if (!track) return <Center>{t("player.lyrics.nothingPlaying")}</Center>;
  if (isLoading)
    return (
      <Center>
        <Icon name="loader" size={28} />
        <span>{t("player.lyrics.looking")}</span>
      </Center>
    );
  if (isError)
    return (
      <Center>
        <span>{t("player.lyrics.sourceDown")}</span>
        <Button size="sm" icon="retry" onClick={() => refetch()}>
          {t("common.retry")}
        </Button>
      </Center>
    );

  const empty = !data || data.source === "none" || (!data.synced && !data.plain);
  const gear = (
    <button
      className="focus-ring absolute right-2 top-2 z-10 flex size-10 items-center justify-center rounded-full bg-black/20 text-np-fg-muted backdrop-blur transition-opacity duration-200 hover:text-fg [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:hover:opacity-100 focus-visible:opacity-100"
      aria-label={t("player.lyrics.tools")}
      onClick={() => setTools("offset")}
    >
      <Icon name="sliders" size={20} />
    </button>
  );

  let body;
  if (empty) {
    body = (
      <div className="h-full overflow-y-auto px-4 py-6">
        <div className="mb-4 flex flex-col items-center gap-2 text-center text-body text-np-fg-muted">
          <Icon name="lyrics" size={36} />
          <span>{t("player.lyrics.none")}</span>
          <span className="text-caption">{t("player.lyrics.noneHint")}</span>
        </div>
        <LyricsSearch trackId={track.id} defaultTitle={track.title} defaultArtist={track.artist} durationSec={track.durationMs / 1000} auto onDone={() => {}} />
        <div className="mt-4 flex justify-center">
          <Button size="sm" variant="ghost" icon="clipboard" onClick={() => setTools("paste")}>
            {t("player.lyrics.paste")}
          </Button>
        </div>
      </div>
    );
  } else if (data.synced) {
    body = <Synced lrc={data.synced} offsetMs={data.offsetMs} size={size} />;
  } else {
    body = (
      <div className={`h-full overflow-y-auto px-6 py-8 ${size === "lg" ? "text-lyric-sm" : "text-title-3"} whitespace-pre-line text-fg`}>
        <p className="mb-6 text-caption uppercase tracking-wider text-np-fg-muted">{t("player.lyrics.unsynced")}</p>
        {data.plain}
      </div>
    );
  }
  return (
    <div className={`relative h-full min-h-0 ${className}`}>
      {!empty && gear}
      {body}
      {tools && <LyricsTools tab={tools} setTab={setTools} lyrics={data} onClose={() => setTools(null)} />}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-body text-np-fg-muted">{children}</div>;
}

function Synced({ lrc, offsetMs, size }: { lrc: string; offsetMs: number; size: "md" | "lg" }) {
  const lines = useMemo(() => parseLRC(lrc), [lrc]);
  const position = usePlayback((s) => s.position);
  const box = useRef<HTMLDivElement>(null);
  const userScrollUntil = useRef(0);
  const active = activeIndex(lines, position + offsetMs / 1000);

  useEffect(() => {
    if (Date.now() < userScrollUntil.current) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${Math.max(active, 0)}"]`);
    if (el && box.current) {
      const target = el.offsetTop - box.current.clientHeight * 0.38;
      box.current.scrollTo({ top: target, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, [active]);

  return (
    <div
      ref={box}
      className="mask-fade-y no-scrollbar relative h-full overflow-y-auto px-6"
      onWheel={() => (userScrollUntil.current = Date.now() + 3000)}
      onTouchMove={() => (userScrollUntil.current = Date.now() + 3000)}
    >
      <div className="h-[35%]" />
      {lines.map((l, i) => (
        <button
          key={i}
          data-line={i}
          onClick={() => {
            userScrollUntil.current = 0;
            engine.seek(Math.max(0, l.t - offsetMs / 1000));
          }}
          className={`focus-ring block w-full rounded-control py-2 text-left transition-[color,opacity,transform] duration-slow ease-out
            ${size === "lg" ? "text-lyric-lg" : "text-lyric-sm"}
            ${i === active ? "text-fg" : i < active ? "text-fg/35" : "text-fg/45 hover:text-fg/70"}`}
        >
          {l.text || "♪"}
        </button>
      ))}
      <div className="h-[50%]" />
    </div>
  );
}

/** Lyrics tools: timing, search with your own words, paste. */
function LyricsTools({ tab, setTab, lyrics, onClose }: { tab: Tab; setTab: (t: Tab) => void; lyrics?: Lyrics; onClose: () => void }) {
  const track = usePlayer((s) => s.current?.track);
  if (!track) return null;
  const tabs: [Tab, string][] = [
    ["offset", t("player.lyrics.tabOffset")],
    ["search", t("player.lyrics.tabSearch")],
    ["paste", t("player.lyrics.tabPaste")],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t("player.lyrics.toolsTitle")} description={`${track.title} · ${track.artist}`}>
      <div role="tablist" className="mb-4 flex gap-1 rounded-full bg-surface-2 p-1">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`focus-ring h-9 flex-1 rounded-full px-3 text-label ${tab === k ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "offset" && <OffsetTool trackId={track.id} lyrics={lyrics} />}
      {tab === "search" && (
        <LyricsSearch trackId={track.id} defaultTitle={track.title} defaultArtist={track.artist} durationSec={track.durationMs / 1000} auto onDone={onClose} />
      )}
      {tab === "paste" && <PasteTool trackId={track.id} initial={lyrics?.synced || lyrics?.plain || ""} onDone={onClose} />}
    </Dialog>
  );
}

function setLyrics(trackId: string, l: Lyrics) {
  queryClient.setQueryData(["lyrics", trackId], l);
}

function OffsetTool({ trackId, lyrics }: { trackId: string; lyrics?: Lyrics }) {
  const [offset, setOffset] = useState(lyrics?.offsetMs ?? 0);
  const timer = useRef<number | null>(null);
  const nudge = (d: number) => {
    const v = d === 0 ? 0 : offset + d;
    setOffset(v);
    queryClient.setQueryData(["lyrics", trackId], (l: Lyrics | undefined) => (l ? { ...l, offsetMs: v } : l));
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api<Lyrics>(`/api/tracks/${trackId}/lyrics`, { method: "PUT", json: { offsetMs: v } }).catch(() => toast(t("player.lyrics.offsetFailed"), "error"));
    }, 500);
  };
  const reset = async () => {
    try {
      setLyrics(trackId, await api<Lyrics>(`/api/tracks/${trackId}/lyrics`, { method: "PUT", json: { reset: true } }));
      toast(t("player.lyrics.resetDone"), "success");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const choice = lyrics?.choice ?? "auto";
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 text-label">{t("player.lyrics.offset")}</div>
        <div className="flex items-center justify-center gap-2">
          <Button onClick={() => nudge(-500)} aria-label={t("player.lyrics.earlier")}>
            −0.5 s
          </Button>
          <span className="min-w-24 text-center text-title-3 tabular" aria-live="polite">
            {offset > 0 ? "+" : ""}
            {(offset / 1000).toFixed(1)} s
          </span>
          <Button onClick={() => nudge(500)} aria-label={t("player.lyrics.later")}>
            +0.5 s
          </Button>
        </div>
        <p className="mt-2 text-center text-caption text-fg-muted">{t("player.lyrics.offsetHint")}</p>
        {offset !== 0 && (
          <div className="mt-1 flex justify-center">
            <Button size="sm" variant="ghost" onClick={() => nudge(0)}>
              {t("player.lyrics.offsetZero")}
            </Button>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-control bg-surface-2 px-3 py-2 text-body-sm">
        <span>
          {t("player.lyrics.source")}: <strong>{t(`player.lyrics.choice.${choice}`)}</strong>
        </span>
        {choice === "mine" && (
          <Button size="sm" variant="ghost" onClick={reset}>
            {t("player.lyrics.useAuto")}
          </Button>
        )}
      </div>
    </div>
  );
}

type Candidate = { id: number; title: string; artist: string; album: string; durationSec: number; synced: boolean; preview: string; picks: number; durationOk: boolean };

/** Search LRCLIB with your own words when the title / artist are written differently. */
function LyricsSearch({
  trackId,
  defaultTitle,
  defaultArtist,
  durationSec,
  auto,
  onDone,
}: {
  trackId: string;
  defaultTitle: string;
  defaultArtist: string;
  durationSec: number;
  auto?: boolean;
  onDone: () => void;
}) {
  const clean = (s: string) => s.replace(/\s*[([][^)\]]*[)\]]/g, "").trim() || s;
  const [title, setTitle] = useState(clean(defaultTitle));
  const [artist, setArtist] = useState((defaultArtist.split(/,|&| ft\.? | feat\.? /i)[0] ?? "").trim());
  const [free, setFree] = useState("");
  const [query, setQuery] = useState<string | null>(auto ? `title=${encodeURIComponent(clean(defaultTitle))}&artist=${encodeURIComponent(artist)}` : null);
  const [busy, setBusy] = useState<number | null>(null);
  const res = useQuery({
    queryKey: ["lyricsCandidates", trackId, query],
    queryFn: () => api<{ results: Candidate[] }>(`/api/tracks/${trackId}/lyrics/candidates?${query}`),
    enabled: query !== null,
    staleTime: 5 * 60_000,
    retry: 0,
  });
  const run = (e?: React.FormEvent) => {
    e?.preventDefault();
    const p = new URLSearchParams();
    if (free.trim()) p.set("q", free.trim());
    else {
      p.set("title", title.trim());
      if (artist.trim()) p.set("artist", artist.trim());
    }
    setQuery(p.toString());
  };
  const pick = async (c: Candidate) => {
    setBusy(c.id);
    try {
      setLyrics(trackId, await api<Lyrics>(`/api/tracks/${trackId}/lyrics`, { method: "PUT", json: { lrclibId: c.id } }));
      toast(t("player.lyrics.picked"), "success");
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={run} className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <input className="input h-10 text-body-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("player.lyrics.songTitle")} aria-label={t("player.lyrics.songTitle")} />
          <input className="input h-10 text-body-sm" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder={t("player.lyrics.artist")} aria-label={t("player.lyrics.artist")} />
        </div>
        <div className="flex gap-2">
          <input className="input h-10 min-w-0 flex-1 text-body-sm" value={free} onChange={(e) => setFree(e.target.value)} placeholder={t("player.lyrics.freeSearch")} aria-label={t("player.lyrics.freeSearch")} />
          <Button type="submit" icon="search" loading={res.isFetching}>
            {t("common.search")}
          </Button>
        </div>
      </form>
      {res.error && <p className="text-body-sm text-danger">{(res.error as Error).message}</p>}
      {res.data && !res.data.results.length && <p className="py-2 text-center text-body-sm text-fg-muted">{t("player.lyrics.noResults")}</p>}
      <ul className="flex max-h-[45dvh] flex-col gap-2 overflow-y-auto">
        {res.data?.results.map((c) => (
          <li key={c.id} className="rounded-control bg-surface-2 p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-label">{c.title}</div>
                <div className="truncate text-caption text-fg-muted">
                  {c.artist}
                  {c.album ? ` · ${c.album}` : ""} · {fmtTime(c.durationSec)}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.synced && <Badge>{t("player.lyrics.synced")}</Badge>}
                  {c.durationOk ? <Badge>{t("player.lyrics.lengthMatches")}</Badge> : durationSec > 0 && <Badge warn>{t("player.lyrics.lengthDiffers")}</Badge>}
                  {c.picks > 0 && <Badge accent>{t("player.lyrics.picks", { n: c.picks })}</Badge>}
                </div>
              </div>
              <Button size="sm" variant="primary" loading={busy === c.id} onClick={() => pick(c)}>
                {t("player.lyrics.use")}
              </Button>
            </div>
            {c.preview && <p className="mt-2 line-clamp-3 whitespace-pre-line text-caption text-fg-muted">{c.preview}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Badge({ children, accent, warn }: { children: React.ReactNode; accent?: boolean; warn?: boolean }) {
  return <span className={`rounded-xs px-1.5 text-caption ${accent ? "bg-accent-soft text-accent" : warn ? "bg-surface-3 text-warning" : "bg-surface-3 text-fg-muted"}`}>{children}</span>;
}

function PasteTool({ trackId, initial, onDone }: { trackId: string; initial: string; onDone: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      setLyrics(trackId, await api<Lyrics>(`/api/tracks/${trackId}/lyrics`, { method: "PUT", json: { text } }));
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body-sm text-fg-muted">{t("player.lyrics.pasteHint")}</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} className="input min-h-52 w-full font-mono text-body-sm" placeholder="[00:12.30] …" />
      <div className="flex justify-end">
        <Button variant="primary" onClick={save} loading={busy}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
