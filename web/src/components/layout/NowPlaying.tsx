import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { coverUrl } from "@/lib/api";
import { usePlayback, usePlayer } from "@/player/store";
import { t, tsv } from "@/i18n";
import { Cover } from "../ui/Cover";
import { IconButton } from "../ui/Button";
import { LikeCurrent, SeekBar, Transport } from "./controls";
import { LyricsView, useLyricLine } from "./LyricsView";
import { QueueView } from "./QueueView";
import { TrackMenuButton } from "../TrackMenu";
import { useSettings } from "@/lib/queries";
import { usePulse } from "./Pulse";
import { ArtistLinks } from "@/components/ArtistLinks";
import { SleepButton } from "@/components/SleepButton";
import { SoundButton } from "@/components/SoundButton";

/** Dark scope with the cover blurred behind a scrim and the accent taken from the cover. */
export function NowPlayingSurface({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  const track = usePlayer((s) => s.current?.track);
  const accent = usePlayback((s) => s.accent);
  const settings = useSettings().data;
  // A fixed accent chosen in Settings wins; "song" follows the cover.
  const followCover = (settings?.accent ?? "song") === "song" || settings?.accent === "indigo";
  const vars = accent && followCover ? ({ "--np-accent": accent, "--np-accent-soft": `color-mix(in srgb, ${accent} 16%, transparent)` } as CSSProperties) : {};
  const positioned = className.split(/\s+/).some((c) => c === "fixed" || c === "absolute");
  const root = useRef<HTMLDivElement>(null);
  const fx = settings?.visualizer ?? true;
  usePulse(root, fx);
  return (
    <div ref={root} data-now-playing className={`isolate overflow-hidden bg-[#0E0F12] text-fg ${positioned ? "" : "relative"} ${className}`} style={{ ...vars, ...style }}>
      {track?.hasCover && (
        <img
          key={track.id}
          src={coverUrl(track.id)}
          alt=""
          aria-hidden
          data-beat
          className="pointer-events-none absolute inset-0 -z-10 size-full object-cover opacity-90 animate-[fade-in_400ms_ease-out] will-change-transform"
          style={
            fx
              ? {
                transform: "scale(calc(1.25 + var(--beat, 0) * 0.12))",
                filter: "blur(var(--np-blur)) saturate(calc(1.15 + var(--energy, 0) * 0.75)) brightness(calc(0.92 + var(--energy, 0) * 0.4))",
              }
              : { transform: "scale(1.25)", filter: "blur(var(--np-blur)) saturate(1.2)" }
          }
        />
      )}
      <div
        data-beat
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: "var(--np-scrim)", opacity: fx ? "calc(1 - var(--energy, 0) * 0.28 - var(--beat, 0) * 0.12)" : undefined }}
      />
      {fx && (
        // Colour that spreads from the middle with the music.
        <div
          data-beat
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 mix-blend-screen"
          style={{
            background:
              "radial-gradient(60% 45% at 50% 38%, color-mix(in srgb, var(--np-accent) 70%, transparent), transparent 70%), radial-gradient(80% 40% at 50% 105%, color-mix(in srgb, var(--np-accent) 45%, transparent), transparent 70%)",
            opacity: "calc(var(--beat, 0) * 0.5 + var(--energy, 0) * 0.22)",
            transform: "scale(calc(0.9 + var(--energy, 0) * 0.25 + var(--beat, 0) * 0.08))",
          }}
        />
      )}
      {children}
    </div>
  );
}

function TrackTitle({ big }: { big?: boolean }) {
  const track = usePlayer((s) => s.current?.track);
  if (!track) return null;
  return (
    <div className="min-w-0 flex-1">
      <h2 className={`truncate ${big ? "text-title-2" : "text-title-3"}`} title={track.title}>
        {track.title}
      </h2>
      <ArtistLinks artist={track.artist} className="block max-w-full truncate text-body text-np-fg-muted" linkClassName="hover:text-fg hover:underline" touch />
    </div>
  );
}

const TABS = ["cover", "lyrics", "queue"] as const;

/** Full-screen Now Playing for mobile and tablet: swipe left / right between cover, lyrics and queue; swipe the cover down to close. */
export function MobileNowPlaying() {
  const open = usePlayer((s) => s.npOpen);
  const tab = usePlayer((s) => s.npTab);
  const setNp = usePlayer((s) => s.setNp);
  const current = usePlayer((s) => s.current);
  const source = usePlayer((s) => s.source);
  const [dy, setDy] = useState(0);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPop = () => setNp(false);
    history.pushState({ np: true }, "");
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (history.state?.np) history.back();
    };
  }, [open, setNp]);

  if (!open || !current) return null;

  const close = () => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      setDy(0);
      setNp(false);
    }, 200);
  };
  const go = (d: number) => {
    const i = TABS.indexOf(tab) + d;
    if (i >= 0 && i < TABS.length) setNp(true, TABS[i]);
  };
  // One gesture handler: horizontal = change tab (anywhere), vertical down = close (cover / header only).
  const gesture = (canClose: boolean) => ({
    onTouchStart: (e: React.TouchEvent) => (start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, axis: null }),
    onTouchMove: (e: React.TouchEvent) => {
      const s = start.current;
      if (!s) return;
      const mx = e.touches[0].clientX - s.x;
      const my = e.touches[0].clientY - s.y;
      if (!s.axis && Math.hypot(mx, my) > 12) s.axis = Math.abs(mx) > Math.abs(my) * 1.3 ? "x" : "y";
      if (s.axis === "x") setDx(mx);
      else if (s.axis === "y" && canClose) setDy(Math.max(0, my));
    },
    onTouchEnd: () => {
      const s = start.current;
      start.current = null;
      if (s?.axis === "x" && Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
      if (s?.axis === "y" && canClose && dy > 120) close();
      else setDy(0);
      setDx(0);
    },
  });

  const labels: Record<(typeof TABS)[number], string> = { cover: t("player.np.cover"), lyrics: t("player.np.lyrics"), queue: t("player.np.queue") };

  return (
    <NowPlayingSurface
      className="fixed inset-0 z-[50] flex flex-col pt-safe pb-safe animate-[sheet-up_250ms_var(--ease-out)]"
      style={{
        transform: closing ? "translateY(100%)" : `translateY(${dy}px)`,
        transition: start.current == null ? "transform 200ms var(--ease-out)" : "none",
      }}
    >
      <div role="dialog" aria-modal aria-label={t("player.np.title")} className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 px-2 pt-2" {...gesture(true)}>
          <IconButton icon="chevron-down" label={t("player.np.minimize")} onClick={close} className="!text-fg" />
          <div className="min-w-0 flex-1 text-center">
            <div className="text-overline uppercase text-np-fg-muted">{t("player.np.playingFrom")}</div>
            <div className="truncate text-label">{source?.name ? tsv(source.name) : t("common.nav.library")}</div>
          </div>
          <SoundButton size={22} className="!text-fg" />
          <SleepButton size={22} className="!text-fg" />
          <TrackMenuButton track={current.track} className="!text-fg" />
        </header>

        <div role="tablist" className="mx-auto mt-2 flex shrink-0 gap-1 rounded-full bg-white/10 p-1">
          {TABS.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setNp(true, k)}
              className={`focus-ring h-9 rounded-full px-4 text-label transition-colors duration-fast ${tab === k ? "bg-np-accent text-np-on-accent" : "text-np-fg-muted"}`}
            >
              {labels[k]}
            </button>
          ))}
        </div>

        <div
          className="relative min-h-0 flex-1"
          {...gesture(tab === "cover")}
          style={{ transform: dx ? `translateX(${dx * 0.35}px)` : undefined, opacity: dx ? 1 - Math.min(Math.abs(dx) / 600, 0.3) : 1 }}
        >
          {tab === "cover" && <CoverStage onLyrics={() => setNp(true, "lyrics")} />}
          {tab === "lyrics" && <LyricsView className="pt-2" />}
          {tab === "queue" && <QueueView />}
        </div>

        <div className="shrink-0 px-6 pb-4">
          <div className="mb-2 flex items-center gap-2">
            <TrackTitle big />
            <LikeCurrent np size={28} />
          </div>
          <SeekBar np />
          <div className="mt-1">
            <Transport size="lg" np />
          </div>
        </div>
      </div>
    </NowPlayingSurface>
  );
}

/** Square cover as large as the space allows; below it, when there is room, the lyric line playing now. */
function CoverStage({ onLyrics }: { onLyrics: () => void }) {
  const current = usePlayer((s) => s.current);
  const line = useLyricLine();
  const box = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setDims({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!current) return null;
  const LINE = 64;
  const roomForLine = dims.h - Math.min(dims.w, dims.h) >= LINE || dims.h - LINE >= dims.w * 0.72;
  const size = Math.max(0, Math.floor(roomForLine ? Math.min(dims.w, dims.h - LINE) : Math.min(dims.w, dims.h)));
  return (
    <div ref={box} className="flex h-full flex-col items-center justify-center px-6 py-4">
      {size > 0 && (
        <div
          data-beat
          className="shrink-0 rounded-card will-change-transform"
          style={{
            transform: "scale(calc(1 + var(--beat, 0) * 0.025))",
            boxShadow: "0 0 calc(var(--beat, 0) * 56px + var(--energy, 0) * 28px) color-mix(in srgb, var(--np-accent) 45%, transparent)",
          }}
        >
          <Cover trackId={current.track.id} hasCover={current.track.hasCover} size={size} rounded="rounded-card" className="aspect-square shrink-0 shadow-sheet" eager />
        </div>
      )}
      {roomForLine && (
        <button
          onClick={onLyrics}
          className="focus-ring mt-3 flex h-[52px] w-full items-center justify-center rounded-control px-2 text-center"
          aria-label={t("player.np.openLyrics")}
        >
          <span key={line ?? ""} className="line-clamp-2 text-title-3 text-fg/90 animate-[fade-in_250ms_ease-out]">
            {line ?? <span className="text-body text-np-fg-muted">{t("player.np.tapForLyrics")}</span>}
          </span>
        </button>
      )}
    </div>
  );
}

/** Desktop right panel: Now Playing / Queue / Lyrics. */
export function RightPanel() {
  const panel = usePlayer((s) => s.panel);
  const setPanel = usePlayer((s) => s.setPanel);
  const current = usePlayer((s) => s.current);
  if (!panel) return null;
  const tabs = [
    { key: "nowplaying" as const, label: t("player.np.title") },
    { key: "queue" as const, label: t("player.np.queue") },
    { key: "lyrics" as const, label: t("player.np.lyrics") },
  ];
  return (
    <NowPlayingSurface className="hidden w-[var(--spacing-panel)] shrink-0 flex-col rounded-card lg:flex">
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        <div role="tablist" className="flex flex-1 gap-1">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              role="tab"
              aria-selected={panel === tb.key}
              onClick={() => setPanel(tb.key)}
              className={`focus-ring h-9 rounded-full px-3 text-label transition-colors duration-fast ${panel === tb.key ? "bg-white/15 text-fg" : "text-np-fg-muted hover:text-fg"}`}
            >
              {tb.label}
            </button>
          ))}
        </div>
        <IconButton icon="close" label={t("player.np.closePanel")} onClick={() => setPanel(null)} size={20} />
      </div>
      <div className="min-h-0 flex-1">
        {panel === "nowplaying" &&
          (current ? (
            <div className="flex h-full flex-col overflow-y-auto px-4 pb-4">
              <Cover trackId={current.track.id} hasCover={current.track.hasCover} size="100%" rounded="rounded-card" className="aspect-square !h-auto shadow-sheet" eager />
              <div className="mt-4 flex items-start gap-2">
                <TrackTitle />
                <LikeCurrent np />
                <TrackMenuButton track={current.track} />
              </div>
              {current.track.album && <p className="mt-2 truncate text-body-sm text-np-fg-muted">{t("player.np.album", { album: current.track.album })}</p>}
              <div className="mt-4 min-h-[240px] flex-1 overflow-hidden rounded-card bg-black/20">
                <div className="flex items-center justify-between px-4 pt-3">
                  <span className="text-overline uppercase text-np-fg-muted">{t("player.np.lyrics")}</span>
                  <button className="focus-ring rounded-xs text-label text-np-accent hover:underline" onClick={() => setPanel("lyrics")}>
                    {t("player.np.expand")}
                  </button>
                </div>
                <div className="h-[260px]">
                  <LyricsView />
                </div>
              </div>
            </div>
          ) : (
            <p className="p-6 text-body text-np-fg-muted">{t("player.lyrics.nothingPlaying")}</p>
          ))}
        {panel === "queue" && <QueueView />}
        {panel === "lyrics" && <LyricsView />}
      </div>
    </NowPlayingSurface>
  );
}

/** Desktop full-screen lyrics (L). */
export function LyricsFullscreen() {
  const open = usePlayer((s) => s.lyricsFull);
  const set = usePlayer((s) => s.setLyricsFull);
  const current = usePlayer((s) => s.current);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && set(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, set]);
  if (!open || !current) return null;
  return (
    <NowPlayingSurface className="fixed inset-0 z-[50] flex flex-col animate-[fade-in_200ms_ease-out]">
      <div className="flex shrink-0 items-center gap-4 px-6 pt-6">
        <Cover trackId={current.track.id} hasCover={current.track.hasCover} size={64} rounded="rounded-control" />
        <TrackTitle big />
        <IconButton
          icon="close"
          label={t("player.np.closeLyrics")}
          shortcut="Esc"
          onClick={() => set(false)}
          className="!text-fg opacity-0 transition-opacity duration-200 hover:opacity-100 focus-visible:opacity-100"
        />
      </div>
      <div className="mx-auto min-h-0 w-full max-w-4xl flex-1">
        <LyricsView size="lg" />
      </div>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-8">
        <SeekBar np />
        <Transport np />
      </div>
    </NowPlayingSurface>
  );
}
