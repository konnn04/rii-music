import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type Stats, type Track } from "@/lib/api";
import { queryClient, useMe } from "@/lib/queries";
import { usePlayback, usePlayer } from "@/player/store";
import { t, tsv } from "@/i18n";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";

type Mood = "happy" | "sad" | "chill" | "energetic" | "focus";
type MoodList = { mood: Mood; name: string; reason: string; tracks: Track[]; analyzed: number };
type Msg = { from: "vani" | "me"; text: string; list?: MoodList };

function partOfDay() {
  const h = new Date().getHours();
  return h < 5 ? "night" : h < 11 ? "morning" : h < 13 ? "noon" : h < 18 ? "afternoon" : "evening";
}

/** Vani: a little character on the home page. Listens along (headphones on while music plays), greets, and makes a playlist for your mood. */
export function Mascot() {
  const me = useMe().data?.user;
  const playing = usePlayback((s) => s.isPlaying);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const tz = new Date().getTimezoneOffset();
  const today = useQuery({ queryKey: ["stats", 1, tz], queryFn: () => api<Stats>(`/api/stats?days=1&tz=${tz}`), staleTime: 60_000 });
  const week = useQuery({ queryKey: ["stats", 7, tz], queryFn: () => api<Stats>(`/api/stats?days=7&tz=${tz}`), staleTime: 60_000, enabled: open });
  const name = me?.name || "";
  const minutes = today.data?.totalMinutes ?? 0;

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

  return (
    <section className="px-4 md:px-0" aria-label={t("mascot.name")}>
      <div className="flex items-end gap-3">
        <button onClick={open ? () => setOpen(false) : start} className="focus-ring shrink-0 rounded-full" aria-label={t("mascot.talk")} aria-expanded={open}>
          <Vani playing={playing} />
        </button>
        <div className="relative mb-3 min-w-0 flex-1 rounded-card rounded-bl-xs bg-surface-1 px-4 py-3">
          <p className="text-body">{bubble}</p>
          <p className="text-body-sm text-fg-muted">
            {playing ? t("mascot.listening") : minutes > 0 ? t("mascot.todayMinutes", { n: minutes }) : t("mascot.nothingYet")}
            {!open && (
              <>
                {" "}
                <button className="focus-ring rounded-xs text-accent hover:underline" onClick={start}>
                  {t("mascot.chat")}
                </button>
              </>
            )}
          </p>
        </div>
      </div>

      {open && (
        <div className="mt-2 rounded-card bg-surface-1 p-4 animate-[fade-in_200ms_ease-out]">
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-live="polite">
            {msgs.map((m, i) => (
              <li key={i} className={`flex ${m.from === "me" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-card px-3 py-2 text-body-sm ${m.from === "me" ? "rounded-br-xs bg-accent text-fg-on-accent" : "rounded-bl-xs bg-surface-2"}`}>
                  {m.text}
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

/** The character: a round vanilla-scoop face; headphones on and bobbing while music plays. */
function Vani({ playing }: { playing: boolean }) {
  return (
    <span className="relative block size-20">
      <svg viewBox="0 0 80 80" className="vani-body size-20" style={{ animation: playing ? "vani-bob 0.9s ease-in-out infinite" : "vani-breathe 3.5s ease-in-out infinite", transformOrigin: "50% 90%" }} aria-hidden>
        <ellipse cx="40" cy="74" rx="20" ry="3" fill="black" opacity="0.25" />
        <path d="M14 46c0-17 11.6-30 26-30s26 13 26 30c0 13-11.6 24-26 24S14 59 14 46z" fill="#F6EBD3" />
        <path d="M20 30c4-8 11-12 20-12s16 4 20 12c-6-3-12-4-20-4s-14 1-20 4z" fill="#FFF7E6" />
        <circle cx="52" cy="24" r="3" fill="#C9A86A" />
        <g className="vani-blink">
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
      </svg>
      {playing && (
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
