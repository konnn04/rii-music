import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type Stats, type Track } from "@/lib/api";
import { queryClient, useMe } from "@/lib/queries";
import { usePlayback, usePlayer } from "@/player/store";
import { locale, t, tn, tsv } from "@/i18n";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";

type Mood = "happy" | "sad" | "chill" | "energetic" | "focus";
type MoodList = { mood: Mood; name: string; reason: string; tracks: Track[]; analyzed: number };
type Streak = {
  current: number;
  best: number;
  todayMinutes: number;
  goalMinutes: number;
  todayDone: boolean;
  atRisk: boolean;
  totalMinutes: number;
  stage: number;
  nextStageAt: number;
  week: number[];
};
type Msg = { from: "vani" | "me"; text: string; list?: MoodList; streakChart?: { week: number[]; goal: number } };

const STAGE_STORAGE_KEY = "rii-vani-stage";

function partOfDay() {
  const h = new Date().getHours();
  return h < 5 ? "night" : h < 11 ? "morning" : h < 13 ? "noon" : h < 18 ? "afternoon" : "evening";
}

function useReducedMotion() {
  const read = () =>
    (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) ||
    (typeof document !== "undefined" && document.documentElement.dataset.lite !== undefined);
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(read());
    mq?.addEventListener("change", update);
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-lite"] });
    return () => {
      mq?.removeEventListener("change", update);
      obs.disconnect();
    };
  }, []);
  return reduced;
}

/** Vani: a little character on the home page. Listens along (headphones on while music plays), greets, tracks your streak, and makes a playlist for your mood. */
export function Mascot() {
  const me = useMe().data?.user;
  const playing = usePlayback((s) => s.isPlaying);
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [stageUp, setStageUp] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const prevPlaying = useRef(playing);
  const navigate = useNavigate();
  const tz = new Date().getTimezoneOffset();
  const today = useQuery({ queryKey: ["stats", 1, tz], queryFn: () => api<Stats>(`/api/stats?days=1&tz=${tz}`), staleTime: 60_000 });
  const week = useQuery({ queryKey: ["stats", 7, tz], queryFn: () => api<Stats>(`/api/stats?days=7&tz=${tz}`), staleTime: 60_000, enabled: open });
  const streak = useQuery({ queryKey: ["streak", tz], queryFn: () => api<Streak>(`/api/streak?tz=${tz}`), staleTime: 60_000 });
  const { refetch: refetchStreak } = streak;
  const name = me?.name || "";
  const minutes = today.data?.totalMinutes ?? 0;
  const st = streak.data;
  const stage = st?.stage ?? 0;

  useEffect(() => {
    if (prevPlaying.current && !playing) {
      void refetchStreak();
    }
    prevPlaying.current = playing;
  }, [playing, refetchStreak]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [open, msgs, busy]);

  useEffect(() => {
    if (!st) return;
    try {
      const raw = localStorage.getItem(STAGE_STORAGE_KEY);
      if (raw !== null) {
        const prev = Number(raw);
        if (Number.isFinite(prev) && st.stage > prev) {
          setStageUp(st.stage);
        }
      }
      localStorage.setItem(STAGE_STORAGE_KEY, String(st.stage));
    } catch {
      /* private mode */
    }
  }, [st]);

  const say = (m: Msg) => setMsgs((xs) => [...xs, m]);
  const start = () => {
    setOpen(true);
    if (!msgs.length) say({ from: "vani", text: t("mascot.askMood") });
  };
  const pickMood = async (mood: Mood) => {
    say({ from: "me", text: t(`mascot.moods.${mood}`) });
    setBusy(true);
    try {
      const l = await api<MoodList>("/api/recs/mood", { method: "POST", json: { mood } });
      const lead = mood === "sad" ? t("mascot.comfort") + " " : "";
      if (!l.tracks.length) say({ from: "vani", text: lead + t("mascot.noTracks") });
      else say({ from: "vani", text: lead + t("mascot.madeList", { name: tsv(l.name), n: l.tracks.length }), list: l });
    } catch (e) {
      say({ from: "vani", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const howLong = () => {
    say({ from: "me", text: t("mascot.howLongQ") });
    say({ from: "vani", text: t("mascot.howLongA", { today: minutes, week: week.data?.totalMinutes ?? "…" }) });
  };
  const askStreak = () => {
    say({ from: "me", text: t("mascot.streak.ask") });
    if (!st) {
      say({ from: "vani", text: t("mascot.streak.loading") });
      return;
    }
    const clampedStage = Math.max(0, Math.min(6, Math.floor(st.stage)));
    const stageName = t(`mascot.stage.${clampedStage}`);
    const base = t("mascot.streak.answer", { current: st.current, best: st.best, stage: stageName });
    const next =
      st.nextStageAt > 0
        ? t("mascot.streak.nextStage", {
            days: Math.max(1, st.nextStageAt - st.best),
            next: t(`mascot.stage.${Math.min(6, clampedStage + 1)}`),
          })
        : t("mascot.streak.maxStage");
    say({ from: "vani", text: `${base} ${next}`, streakChart: { week: st.week, goal: st.goalMinutes } });
  };
  const play = (l: MoodList) => usePlayer.getState().playList(l.tracks, 0, { type: "mix", name: tsv(l.name), id: "mood:" + l.mood }, { shuffle: false });
  const save = async (l: MoodList) => {
    try {
      const p = await api<{ id: string; name: string }>("/api/playlists", {
        method: "POST",
        json: { name: `${tsv(l.name)} · ${new Date().toLocaleDateString()}`, trackIds: l.tracks.map((x) => x.id) },
      });
      queryClient.invalidateQueries({ queryKey: ["playlists"] });
      toast(t("mascot.saved", { name: p.name }), "success");
      navigate({ to: "/playlist/$id", params: { id: p.id } });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const bubble = name ? t(`mascot.hello.${partOfDay()}`, { name }) : t(`mascot.helloAnon.${partOfDay()}`);
  const leftMinutes = st ? Math.max(1, st.goalMinutes - st.todayMinutes) : 0;

  return (
    <section className="px-4 md:px-0" aria-label={t("mascot.name")}>
      <div className="flex items-end gap-3">
        <button onClick={open ? () => setOpen(false) : start} className="focus-ring shrink-0 rounded-full" aria-label={t("mascot.talk")} aria-expanded={open}>
          <Vani playing={playing} stage={stage} reduced={reduced} />
        </button>
        <div className="relative mb-3 min-w-0 flex-1 rounded-card rounded-bl-xs bg-surface-1 px-4 py-3">
          <p className="text-body">{bubble}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-fg-muted">
            <span>
              {playing ? t("mascot.listening") : minutes > 0 ? t("mascot.todayMinutes", { n: minutes }) : t("mascot.nothingYet")}
              {!open && (
                <>
                  {" "}
                  <button className="focus-ring rounded-xs text-accent hover:underline" onClick={start}>
                    {t("mascot.chat")}
                  </button>
                </>
              )}
            </span>
            {st &&
              (st.current > 0 ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption ${
                    st.todayDone ? "bg-accent-soft text-accent" : st.atRisk ? "bg-surface-2 text-warning" : "bg-surface-2 text-fg-muted"
                  }`}
                >
                  <span aria-hidden>🔥</span>
                  <span>{tn("mascot.streak.days", st.current)}</span>
                  {st.todayDone && <Icon name="check" size={12} className="text-success" />}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-caption text-fg-muted">
                  <span aria-hidden>🔥</span>
                  <span>{t("mascot.streak.start")}</span>
                </span>
              ))}
          </div>
          {st?.atRisk && st.goalMinutes > st.todayMinutes && (
            <p className="mt-1 text-caption text-warning">{t("mascot.streak.atRisk", { left: leftMinutes })}</p>
          )}
          {stageUp !== null && (
            <p className="mt-1 flex items-center gap-1.5 text-caption text-accent">
              <span className={reduced ? "" : "vani-sparkle inline-block"} aria-hidden>
                ✨
              </span>
              <span>{t("mascot.stage.up", { name: t(`mascot.stage.${Math.max(0, Math.min(6, Math.floor(stageUp)))}`) })}</span>
              {!reduced && (
                <span className="vani-confetti inline-flex items-center gap-0.5" aria-hidden>
                  <span className="size-1.5 rounded-full bg-accent" />
                  <span className="size-1.5 rounded-full bg-warning" />
                  <span className="size-1.5 rounded-full bg-success" />
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-2 rounded-card bg-surface-1 p-4 animate-[fade-in_200ms_ease-out]">
          <ul ref={listRef} className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-live="polite">
            {msgs.map((m, i) => (
              <li key={i} className={`flex ${m.from === "me" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-card px-3 py-2 text-body-sm ${m.from === "me" ? "rounded-br-xs bg-accent text-fg-on-accent" : "rounded-bl-xs bg-surface-2"}`}>
                  {m.text}
                  {m.streakChart && <StreakWeekChart week={m.streakChart.week} goal={m.streakChart.goal} />}
                  {m.list && m.list.tracks.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="primary" icon="play" onClick={() => play(m.list!)}>
                        {t("common.play")}
                      </Button>
                      <Button size="sm" icon="playlist-add" onClick={() => save(m.list!)}>
                        {t("mascot.savePlaylist")}
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
            {busy && (
              <li className="flex items-center gap-2 text-body-sm text-fg-muted">
                <Icon name="loader" size={16} /> {t("mascot.thinking")}
              </li>
            )}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["happy", "sad", "chill", "energetic", "focus"] as Mood[]).map((m) => (
              <button key={m} disabled={busy} onClick={() => pickMood(m)} className="focus-ring h-9 rounded-full bg-surface-2 px-3 text-label hover:bg-surface-3 disabled:opacity-50">
                {t(`mascot.moodEmoji.${m}`)} {t(`mascot.moods.${m}`)}
              </button>
            ))}
            <button onClick={askStreak} className="focus-ring h-9 rounded-full bg-surface-2 px-3 text-label hover:bg-surface-3">
              {t("mascot.streak.ask")}
            </button>
            <button onClick={howLong} className="focus-ring h-9 rounded-full bg-surface-2 px-3 text-label hover:bg-surface-3">
              {t("mascot.howLongQ")}
            </button>
            <button onClick={() => navigate({ to: "/discover" })} className="focus-ring h-9 rounded-full bg-surface-2 px-3 text-label hover:bg-surface-3">
              {t("mascot.newMusic")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function StreakWeekChart({ week, goal }: { week: number[]; goal: number }) {
  if (!week.length) return null;
  const max = Math.max(goal, ...week, 1);
  const goalPct = Math.min(100, (goal / max) * 100);
  const metDays = week.filter((m) => m >= goal).length;
  const total = week.reduce((a, b) => a + b, 0);
  const loc = locale();
  const now = Date.now();
  const labels = week.map((_, i) => new Date(now - (week.length - 1 - i) * 86_400_000).toLocaleDateString(loc, { weekday: "narrow" }));

  return (
    <div
      role="img"
      aria-label={t("mascot.streak.chartLabel", { met: metDays, days: week.length, total, goal })}
      className="mt-2.5 rounded-control bg-surface-1/70 px-2.5 py-2"
    >
      <div className="relative flex h-12 items-end gap-1.5">
        <div
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-fg-subtle/50"
          style={{ bottom: `${goalPct}%` }}
          aria-hidden
        />
        {week.map((mins, i) => {
          const met = mins >= goal;
          const pct = mins > 0 ? Math.max(10, Math.round((mins / max) * 100)) : 5;
          return (
            <div key={i} className="flex h-full flex-1 items-end" title={`${mins} ${t("mascot.streak.minUnit")}`}>
              <div
                className={`w-full rounded-xs transition-[height] ${met ? "bg-accent" : "bg-surface-4"}`}
                style={{ height: `${pct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-center text-[10px] text-fg-subtle" aria-hidden>
        {labels.map((lbl, i) => (
          <span key={i} className={`flex-1 ${i === labels.length - 1 ? "font-semibold text-fg" : ""}`}>
            {lbl}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The character: a round vanilla-scoop face; evolves with streak stage, headphones on and bobbing while music plays. */
function Vani({ playing, stage = 0, reduced = false }: { playing: boolean; stage?: number; reduced?: boolean }) {
  const uid = useId();
  const s = Math.max(0, Math.min(6, Math.floor(stage)));
  const haloGlowId = `${uid}-halo-glow`;
  const haloRingId = `${uid}-halo-ring`;

  return (
    <span className="relative block size-20">
      <svg
        viewBox="0 0 80 80"
        className="vani-body size-20"
        style={reduced ? undefined : { animation: playing ? "vani-bob 0.9s ease-in-out infinite" : "vani-breathe 3.5s ease-in-out infinite", transformOrigin: "50% 90%" }}
        aria-hidden
      >
        {s >= 6 && (
          <defs>
            <radialGradient id={haloGlowId} cx="50%" cy="50%" r="50%">
              <stop offset="55%" stopColor="var(--color-accent)" stopOpacity="0.45" />
              <stop offset="85%" stopColor="#F5C451" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </radialGradient>
            <linearGradient id={haloRingId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--color-accent)" />
              <stop offset="50%" stopColor="#F5C451" />
              <stop offset="100%" stopColor="#FFF7E6" />
            </linearGradient>
          </defs>
        )}

        {/* Stage 6: soft glowing halo ring behind Vani */}
        {s >= 6 && (
          <g className={reduced ? undefined : "vani-halo"}>
            <circle cx="40" cy="43" r="36" fill={`url(#${haloGlowId})`} />
            <ellipse cx="40" cy="43" rx="33" ry="31" fill="none" stroke={`url(#${haloRingId})`} strokeWidth="2.2" opacity="0.85" />
            <circle cx="9" cy="24" r="1.4" fill="#FFF7E6" opacity="0.9" />
            <circle cx="71" cy="25" r="1.6" fill="#F5C451" opacity="0.9" />
            <circle cx="69" cy="60" r="1.2" fill="var(--color-accent)" opacity="0.9" />
          </g>
        )}

        <ellipse cx="40" cy="74" rx="20" ry="3" fill="black" opacity="0.25" />
        <path d="M14 46c0-17 11.6-30 26-30s26 13 26 30c0 13-11.6 24-26 24S14 59 14 46z" fill="#F6EBD3" />
        <path d="M20 30c4-8 11-12 20-12s16 4 20 12c-6-3-12-4-20-4s-14 1-20 4z" fill="#FFF7E6" />
        <circle cx="52" cy="24" r="3" fill="#C9A86A" />

        <g className={reduced ? undefined : "vani-blink"}>
          <ellipse cx="32" cy="45" rx="3.2" ry="4" fill="#2B2420" />
          <ellipse cx="48" cy="45" rx="3.2" ry="4" fill="#2B2420" />
        </g>
        <circle cx="26" cy="53" r="3.5" fill="#F2A7A0" opacity="0.7" />
        <circle cx="54" cy="53" r="3.5" fill="#F2A7A0" opacity="0.7" />
        <path d={playing ? "M34 54q6 6 12 0" : "M35 55q5 3 10 0"} stroke="#2B2420" strokeWidth="2" fill="none" strokeLinecap="round" />

        {playing ? (
          <g>
            <path d="M14 42c0-16 11.6-27 26-27s26 11 26 27" stroke="var(--color-accent)" strokeWidth="4" fill="none" strokeLinecap="round" />
            <rect x="8" y="38" width="10" height="16" rx="5" fill="var(--color-accent)" />
            <rect x="62" y="38" width="10" height="16" rx="5" fill="var(--color-accent)" />
          </g>
        ) : (
          <path d="M24 68c4 4 28 4 32 0" stroke="var(--color-fg-subtle)" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.7" />
        )}

        {/* Stage 1: small sprout/leaf on top */}
        {s === 1 && (
          <g>
            <path d="M40 16c0-4 1-7 4-9" stroke="#5EA86B" strokeWidth="2" fill="none" strokeLinecap="round" />
            <path d="M41 11c3-4 8-4 9-1-2 3-6 4-9 1z" fill="#6EC27C" />
            <path d="M40 13c-3-3-7-2-7 1 2 2 5 2 7-1z" fill="#5EA86B" />
          </g>
        )}

        {/* Stage 2 & 3: cherry on top */}
        {(s === 2 || s === 3) && (
          <g>
            <path d="M40 11c0-4 2-7 6-8" stroke="#6E4E37" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            <path d="M43 5.5c2-2 5-2 6 0-2 1.5-4.5 1.5-6 0z" fill="#6EC27C" />
            <circle cx="40" cy="13.5" r="4.8" fill="#E05263" />
            <circle cx="38.2" cy="11.8" r="1.4" fill="#FFD6DC" opacity="0.85" />
          </g>
        )}

        {/* Stage 3: small round sunglasses pushed up on the head */}
        {s === 3 && (
          <g>
            <path d="M23 31h3M37 31h6M54 31h3" stroke="#2B2420" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="31.5" cy="31.5" r="5" fill="#2B2420" stroke="var(--color-accent)" strokeWidth="1.4" />
            <circle cx="48.5" cy="31.5" r="5" fill="#2B2420" stroke="var(--color-accent)" strokeWidth="1.4" />
            <path d="M29.6 29.6l1.8 1.8M46.6 29.6l1.8 1.8" stroke="#FFF7E6" strokeWidth="1.1" strokeLinecap="round" opacity="0.7" />
          </g>
        )}

        {/* Stage 4: small star badge & sparkles around */}
        {s === 4 && (
          <g>
            <polygon
              points="40,5.5 42.1,10 47,10.6 43.4,14 44.3,18.8 40,16.5 35.7,18.8 36.6,14 33,10.6 37.9,10"
              fill="#F5C451"
              stroke="#C98A1A"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            <path
              d="M11 18l1.2 3.2L15.4 22.4l-3.2 1.2L11 26.8l-1.2-3.2-3.2-1.2 3.2-1.2z"
              fill="var(--color-accent)"
              className={reduced ? undefined : "vani-twinkle"}
            />
            <path
              d="M68 16l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z"
              fill="#F5C451"
              className={reduced ? undefined : "vani-twinkle"}
              style={reduced ? undefined : { animationDelay: "0.7s" }}
            />
            <circle cx="13" cy="60" r="1.6" fill="#F5C451" opacity="0.85" />
            <circle cx="67" cy="58" r="1.5" fill="var(--color-accent)" opacity="0.85" />
          </g>
        )}

        {/* Stage 5 & 6: tiny golden crown */}
        {s >= 5 && (
          <g>
            <path d="M30 16.5L29 7.5l6.5 4.5L40 5.5l4.5 6.5L51 7.5l-1 9z" fill="#F5C451" stroke="#C98A1A" strokeWidth="1.2" strokeLinejoin="round" />
            <rect x="30" y="15" width="20" height="2.6" rx="1.2" fill="#E3A92B" />
            <circle cx="40" cy="13.5" r="1.5" fill="var(--color-accent)" />
            <circle cx="34.5" cy="13.8" r="1" fill="#FFF7E6" />
            <circle cx="45.5" cy="13.8" r="1" fill="#FFF7E6" />
          </g>
        )}
      </svg>
      {playing && !reduced && (
        <>
          <span className="vani-note absolute right-0 top-2 text-accent" style={{ animation: "vani-note 1.8s ease-out infinite" }} aria-hidden>
            ♪
          </span>
          <span className="vani-note absolute right-3 top-4 text-accent" style={{ animation: "vani-note 1.8s ease-out 0.9s infinite" }} aria-hidden>
            ♫
          </span>
        </>
      )}
    </span>
  );
}
