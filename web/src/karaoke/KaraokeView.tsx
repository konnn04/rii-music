import { useEffect, useMemo, useRef, useState } from "react";
import { ArtistLinks } from "@/components/ArtistLinks";
import { SeekBar, Transport } from "@/components/layout/controls";
import { activeIndex, parseLRC, type Line } from "@/components/layout/LyricsView";
import { NowPlayingSurface } from "@/components/layout/NowPlaying";
import { IconButton } from "@/components/ui/Button";
import { Cover } from "@/components/ui/Cover";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/i18n";
import { useLyrics } from "@/lib/queries";
import { engine } from "@/player/engine";
import { usePlayback, usePlayer } from "@/player/store";
import { KaraokeControls } from "./KaraokeControls";
import { openKaraoke, setKey, useKaraoke } from "./store";
import { KaraokeExportButton } from "./video/ExportButton";

const FOLLOW_KEY = "rii-karaoke-follow";

function readFollow(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) === "1";
  } catch {
    return false;
  }
}

type WordToken = { text: string; threshold: number };

function splitWords(raw: string): WordToken[] {
  const text = raw || "♪";
  const total = text.length;
  const tokens: WordToken[] = [];
  const re = /\S+\s*|\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], threshold: m.index / total });
  }
  return tokens;
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export function KaraokeView() {
  const open = useKaraoke((s) => s.open);
  const current = usePlayer((s) => s.current);
  const track = current?.track;
  const { data: lyrics, isLoading } = useLyrics(track?.id);
  const [follow, setFollow] = useState(readFollow);

  const toggleFollow = () => {
    setFollow((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(FOLLOW_KEY, next ? "1" : "0");
      } catch {
        /* private mode */
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.querySelector('[role="dialog"]')) return; // the dialog closes first
        e.preventDefault();
        openKaraoke(false);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "[" && !engine.simpleMode) {
        e.preventDefault();
        setKey(useKaraoke.getState().key - 1);
      } else if (e.key === "]" && !engine.simpleMode) {
        e.preventDefault();
        setKey(useKaraoke.getState().key + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const lines = useMemo(() => (lyrics?.synced ? parseLRC(lyrics.synced) : []), [lyrics?.synced]);
  const offsetSec = (lyrics?.offsetMs ?? 0) / 1000;

  if (!open) return null;

  return (
    <NowPlayingSurface className="fixed inset-0 z-[55] flex flex-col pt-safe pb-safe animate-[fade-in_200ms_ease-out]">
      {/* Extra darkening layer for high karaoke readability */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-black/35" />

      <div role="dialog" aria-modal aria-label={t("karaoke.title")} className="flex min-h-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex shrink-0 items-center gap-3 px-4 pt-4 md:px-6 md:pt-6">
          {track ? (
            <>
              <Cover trackId={track.id} hasCover={track.hasCover} size={52} rounded="rounded-control" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-np-accent-soft px-2 py-0.5 text-caption text-np-accent">
                    <Icon name="mic" size={14} />
                    {t("karaoke.title")}
                  </span>
                </div>
                <h2 className="mt-0.5 truncate text-title-3" title={track.title}>
                  {track.title}
                </h2>
                <ArtistLinks artist={track.artist} className="block max-w-full truncate text-body-sm text-np-fg-muted" linkClassName="hover:text-fg hover:underline" touch />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center gap-2 text-title-3">
              <Icon name="mic" size={22} className="text-np-accent" />
              {t("karaoke.title")}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              icon="lyrics"
              label={t("karaoke.lyrics.follow")}
              active={follow}
              onClick={toggleFollow}
              className={
                follow
                  ? "!text-np-accent bg-np-accent-soft hover:bg-np-accent-soft"
                  : "!text-np-fg-muted hover:!text-fg hover:bg-white/10"
              }
            />
            <KaraokeExportButton />
            <IconButton
              icon="close"
              label={t("karaoke.close")}
              shortcut="Esc"
              onClick={() => openKaraoke(false)}
              className="!text-fg hover:bg-white/10"
            />
          </div>
        </header>

        {/* Center lyric stage */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-4">
          {!track ? (
            <EmptyStage icon="mic" message={t("karaoke.nothingPlaying")} />
          ) : isLoading ? (
            <div className="flex flex-col items-center gap-3 text-np-fg-muted">
              <Icon name="loader" size={32} />
              <span className="text-body">{t("player.lyrics.looking")}</span>
            </div>
          ) : lines.length > 0 ? (
            <SyncedStage lines={lines} offsetSec={offsetSec} follow={follow} />
          ) : lyrics?.plain ? (
            <PlainStage text={lyrics.plain} />
          ) : (
            <EmptyStage icon="lyrics" message={t("karaoke.noSynced")} />
          )}
        </div>

        {/* Bottom controls */}
        <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-3 px-4 pb-5 md:px-6 md:pb-6">
          <KaraokeControls />
          <div>
            <SeekBar np />
            <div className="mt-1">
              <Transport np />
            </div>
          </div>
        </div>
      </div>
    </NowPlayingSurface>
  );
}

function EmptyStage({ icon, message }: { icon: "mic" | "lyrics"; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center text-np-fg-muted">
      <Icon name={icon} size={40} />
      <p className="text-title-3 text-fg/80">{message}</p>
    </div>
  );
}

/**
 * Large centered karaoke line (solid accent by default, or optional word-by-word highlight),
 * previous/next context lines, and a 3-2-1 countdown before the first line.
 */
function SyncedStage({ lines, offsetSec, follow }: { lines: Line[]; offsetSec: number; follow: boolean }) {
  const [active, setActive] = useState(() => activeIndex(lines, usePlayback.getState().position + offsetSec));
  const [countdown, setCountdown] = useState<number>(0);
  const [sungWords, setSungWords] = useState<number>(0);
  const lineWords = useMemo(() => lines.map((l) => splitWords(l.text)), [lines]);

  // Anchor the latest known playback position so rAF can interpolate smoothly between timeupdate events.
  const anchorRef = useRef({ pos: usePlayback.getState().position, at: performance.now(), playing: usePlayback.getState().isPlaying });

  useEffect(() => {
    const sync = (pos: number, playing: boolean) => {
      anchorRef.current = { pos, at: performance.now(), playing };
    };
    const initial = usePlayback.getState();
    sync(initial.position, initial.isPlaying);
    const unsub = usePlayback.subscribe((s, prev) => {
      if (s.position !== prev.position || s.isPlaying !== prev.isPlaying) {
        sync(s.position, s.isPlaying);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    let raf = 0;
    let lastActive = -2;
    let lastCountdown = -1;
    let lastSung = -1;

    const tick = () => {
      const a = anchorRef.current;
      const dur = usePlayback.getState().duration;
      const elapsed = a.playing ? (performance.now() - a.at) / 1000 : 0;
      const rawPos = a.pos + elapsed;
      const pos = dur > 0 ? Math.min(rawPos, dur) : rawPos;
      const at = pos + offsetSec;

      const idx = activeIndex(lines, at);
      if (idx !== lastActive) {
        lastActive = idx;
        setActive(idx);
      }

      if (idx < 0 && lines.length > 0) {
        const until = lines[0].t - at;
        const dots = until > 0 && until < 4 ? Math.min(3, Math.max(1, Math.ceil(until))) : 0;
        if (dots !== lastCountdown) {
          lastCountdown = dots;
          setCountdown(dots);
        }
      } else if (lastCountdown !== 0) {
        lastCountdown = 0;
        setCountdown(0);
      }

      if (follow) {
        let sung = 0;
        if (idx >= 0) {
          const start = lines[idx].t;
          const nextT = idx + 1 < lines.length ? lines[idx + 1].t : Math.max(start + 4, dur + offsetSec);
          const span = Math.max(0.25, nextT - start);
          const progress = Math.max(0, Math.min(1, (at - start) / span));
          const words = lineWords[idx];
          while (sung < words.length && progress >= words[sung].threshold) {
            sung++;
          }
        }
        if (sung !== lastSung) {
          lastSung = sung;
          setSungWords(sung);
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lines, lineWords, offsetSec, follow]);

  const seekTo = (line: Line) => {
    engine.seek(Math.max(0, line.t - offsetSec));
  };

  const prevLine = active > 0 ? lines[active - 1] : null;
  const curLine = active >= 0 ? lines[active] : null;
  const nextLine = active + 1 < lines.length ? lines[active + 1] : null;

  return (
    <div className="flex w-full max-w-5xl flex-col items-center justify-center gap-5 text-center select-none">
      {/* Previous line (faint) */}
      <div className="flex min-h-[2.25rem] items-end justify-center">
        {prevLine && (
          <button
            type="button"
            onClick={() => seekTo(prevLine)}
            className="focus-ring rounded-control px-3 py-1 text-[clamp(1.05rem,2.2vw,1.5rem)] font-semibold leading-snug text-fg/30 transition-colors duration-fast hover:text-fg/55"
          >
            {prevLine.text || "♪"}
          </button>
        )}
      </div>

      {/* Current line (solid accent by default, or word-by-word highlight) or 3-2-1 countdown */}
      <div className="flex min-h-[clamp(4.5rem,12vh,8rem)] items-center justify-center px-2">
        {curLine ? (
          follow ? (
            <p key={active} className="text-[clamp(2.2rem,5vw,4rem)] font-bold leading-[1.18] tracking-[-0.02em]">
              {lineWords[active].map((w, i) => (
                <span
                  key={i}
                  className={`transition-colors duration-[120ms] ${i < sungWords ? "text-np-accent" : "text-fg/35"}`}
                >
                  {w.text}
                </span>
              ))}
            </p>
          ) : (
            <p
              key={active}
              className="text-[clamp(2.2rem,5vw,4rem)] font-bold leading-[1.18] tracking-[-0.02em] text-np-accent"
            >
              {curLine.text || "♪"}
            </p>
          )
        ) : countdown > 0 ? (
          <div className="flex items-center gap-4" role="status" aria-label={t("karaoke.countdown", { n: countdown })}>
            {[1, 2, 3].map((dot) => {
              const lit = dot <= countdown;
              return (
                <span
                  key={dot}
                  className={`size-5 rounded-full transition-all duration-fast ${
                    lit ? "scale-110 bg-np-accent shadow-[0_0_20px_var(--np-accent)]" : "scale-90 bg-white/20"
                  }`}
                />
              );
            })}
          </div>
        ) : (
          <span className="text-[clamp(2rem,4vw,3rem)] font-bold text-fg/30">♪</span>
        )}
      </div>

      {/* Next line (smaller, dimmed) */}
      <div className="flex min-h-[2.5rem] items-start justify-center">
        {nextLine && (
          <button
            type="button"
            onClick={() => seekTo(nextLine)}
            className="focus-ring rounded-control px-3 py-1 text-[clamp(1.2rem,2.6vw,1.85rem)] font-semibold leading-snug text-fg/55 transition-colors duration-fast hover:text-fg/80"
          >
            {nextLine.text || "♪"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Unsynced plain lyrics that scroll gently along with song progress. */
function PlainStage({ text }: { text: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const userScrollUntil = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = boxRef.current;
      const { position, duration, isPlaying } = usePlayback.getState();
      if (el && isPlaying && duration > 0 && Date.now() >= userScrollUntil.current) {
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (maxScroll > 0) {
          const target = Math.max(0, Math.min(maxScroll, (position / duration) * maxScroll));
          el.scrollTop += (target - el.scrollTop) * 0.04;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);

  return (
    <div className="flex h-full w-full max-w-3xl flex-col items-center">
      <p className="mb-3 shrink-0 text-caption uppercase tracking-wider text-np-fg-muted">{t("karaoke.plainScrolling")}</p>
      <div
        ref={boxRef}
        onWheel={() => {
          userScrollUntil.current = Date.now() + 4000;
        }}
        onTouchMove={() => {
          userScrollUntil.current = Date.now() + 4000;
        }}
        className="mask-fade-y no-scrollbar min-h-0 w-full flex-1 overflow-y-auto px-4 py-12 text-center text-[clamp(1.35rem,3vw,2rem)] font-semibold leading-relaxed whitespace-pre-line text-fg/85"
      >
        {text}
      </div>
    </div>
  );
}

export default KaraokeView;
