import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Track } from "@/lib/api";

/**
 * `auto`: added by autoplay (Tự động gợi ý phát), not by the user.
 * `added`: put in with "Thêm vào hàng chờ" (after the list being played, before autoplay).
 */
export type QueueEntry = { uid: string; track: Track; auto?: boolean; added?: boolean };
export type Source = { type: "library" | "playlist" | "album" | "artist" | "mix" | "radio" | "search" | "queue" | "history"; id?: string; name: string };
export type Repeat = "off" | "all" | "one";
export type AutoplayMode = "off" | "lib" | "free";
export type PanelTab = "nowplaying" | "queue" | "lyrics";

let uidSeq = 0;
export const newUid = () => `${Date.now().toString(36)}-${(uidSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** A track without an id can't be played: never let one into the queue. */
const playable = (ts: Track[]) => ts.filter((t) => t?.id);
const entries = (ts: Track[]): QueueEntry[] => playable(ts).map((track) => ({ uid: newUid(), track }));

/** Index just after the user's part of the upcoming context (autoplay suggestions sit at the end). */
function activeEnd(context: QueueEntry[], pos: number) {
  let i = context.length;
  while (i > pos + 1 && context[i - 1].auto) i--;
  return i;
}

function shuffled<T>(a: T[]): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

type State = {
  /** Tracks from the source being played, in play order (shuffled when shuffle is on). */
  context: QueueEntry[];
  /** Unshuffled order, kept so shuffle can be turned off. */
  original: QueueEntry[] | null;
  /** Index into context of the current track (or the last context track when a manual one is playing). */
  pos: number;
  /** "Hàng đợi thêm tay": plays before the rest of the context. */
  manual: QueueEntry[];
  current: QueueEntry | null;
  currentFromManual: boolean;
  source: Source | null;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  /** Bumped to ask the engine to start playback of `current` even if it is unchanged. */
  playToken: number;
  autoplay: boolean;
  /**
   * Tự động gợi ý phát when the queue runs out: off; lib = similar songs from
   * the library; free = also new songs, downloaded in the background.
   */
  autoplayMode: AutoplayMode;

  // UI
  panel: PanelTab | null;
  npOpen: boolean;
  npTab: "cover" | "lyrics" | "queue";
  lyricsFull: boolean;
};

type Actions = {
  playList: (tracks: Track[], start: number, source: Source, opts?: { shuffle?: boolean; oneLang?: boolean }) => void;
  playNext: (tracks: Track[]) => void;
  addToQueue: (tracks: Track[]) => void;
  /** Advance; returns false when the queue ended. */
  advance: () => boolean;
  back: () => boolean;
  peekNext: () => QueueEntry | null;
  jumpTo: (uid: string) => void;
  removeUpcoming: (uid: string) => void;
  moveUpcoming: (fromUid: string, toUid: string) => void;
  clearManual: () => void;
  /** Append autoplay suggestions to the end of the context. */
  appendAuto: (tracks: Track[]) => void;
  /** Insert one autoplay suggestion into the context at `index`. */
  insertAuto: (track: Track, index: number) => void;
  setAutoplayMode: (m: AutoplayMode) => void;
  clearUpcoming: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  patchTrack: (id: string, patch: Partial<Track>) => void;
  removeTrackEverywhere: (id: string) => void;
  setPanel: (p: PanelTab | null) => void;
  togglePanel: (p: PanelTab) => void;
  setNp: (open: boolean, tab?: State["npTab"]) => void;
  setLyricsFull: (v: boolean) => void;
};

export const usePlayer = create<State & Actions>()(
  persist(
    (set, get) => ({
      context: [],
      original: null,
      pos: 0,
      manual: [],
      current: null,
      currentFromManual: false,
      source: null,
      volume: 0.8,
      muted: false,
      shuffle: false,
      repeat: "off",
      playToken: 0,
      autoplay: false,
      autoplayMode: "free",
      panel: null,
      npOpen: false,
      npTab: "cover",
      lyricsFull: false,

      playList: (tracks, start, source, opts) => {
        if (tracks.some((t) => !t?.id)) {
          const picked = tracks[start];
          tracks = playable(tracks);
          start = start < 0 ? start : Math.max(0, tracks.indexOf(picked));
        }
        if (!tracks.length) return;
        if (opts?.oneLang && start >= 0 && start < tracks.length) {
          // Mixed shelves (continue listening, recently added…): keep only the
          // songs in the language of the one picked, autoplay fills the rest.
          const lang = tracks[start].lang;
          if (lang) {
            const picked = tracks[start];
            tracks = tracks.filter((t) => !t.lang || t.lang === lang);
            start = tracks.indexOf(picked);
          }
        }
        const list = entries(tracks);
        const startEntry = list[Math.max(0, Math.min(start, list.length - 1))];
        const shuffle = opts?.shuffle ?? get().shuffle;
        let context = list;
        let pos = list.indexOf(startEntry);
        if (shuffle) {
          const rest = shuffled(list.filter((e) => e !== startEntry));
          context = opts?.shuffle && start < 0 ? shuffled(list) : [startEntry, ...rest];
          pos = 0;
        }
        set((s) => ({
          context,
          original: shuffle ? list : null,
          pos,
          current: context[pos],
          currentFromManual: false,
          source,
          shuffle,
          autoplay: true,
          playToken: s.playToken + 1,
        }));
      },

      playNext: (tracks) => {
        if (!get().current) return get().playList(tracks, 0, { type: "queue", name: "Hàng đợi" });
        set((s) => ({ manual: [...entries(tracks), ...s.manual] }));
      },
      // "Thêm vào hàng chờ": after what the user chose to play (the rest of the
      // list and earlier additions), before autoplay suggestions. "Phát tiếp
      // theo" (playNext) is the one that jumps ahead.
      addToQueue: (tracks) => {
        if (!get().current) return get().playList(tracks, 0, { type: "queue", name: "Hàng đợi" });
        set((s) => {
          const add = playable(tracks).map((track) => ({ uid: newUid(), track, added: true }));
          const i = activeEnd(s.context, s.pos);
          return { context: [...s.context.slice(0, i), ...add, ...s.context.slice(i)], original: s.original ? [...s.original, ...add] : null };
        });
      },

      peekNext: () => {
        const s = get();
        if (s.manual.length) return s.manual[0];
        if (s.pos + 1 < s.context.length) return s.context[s.pos + 1];
        if (s.repeat === "all" && s.context.length) return s.context[0];
        return null;
      },

      advance: () => {
        const s = get();
        if (s.manual.length) {
          set({ current: s.manual[0], manual: s.manual.slice(1), currentFromManual: true, autoplay: true, playToken: s.playToken + 1 });
          return true;
        }
        if (s.pos + 1 < s.context.length) {
          set({ pos: s.pos + 1, current: s.context[s.pos + 1], currentFromManual: false, autoplay: true, playToken: s.playToken + 1 });
          return true;
        }
        if (s.repeat === "all" && s.context.length) {
          set({ pos: 0, current: s.context[0], currentFromManual: false, autoplay: true, playToken: s.playToken + 1 });
          return true;
        }
        return false;
      },

      back: () => {
        const s = get();
        if (s.currentFromManual && s.context[s.pos]) {
          set({ current: s.context[s.pos], currentFromManual: false, autoplay: true, playToken: s.playToken + 1 });
          return true;
        }
        if (s.pos > 0) {
          set({ pos: s.pos - 1, current: s.context[s.pos - 1], currentFromManual: false, autoplay: true, playToken: s.playToken + 1 });
          return true;
        }
        if (s.repeat === "all" && s.context.length > 1) {
          const last = s.context.length - 1;
          set({ pos: last, current: s.context[last], currentFromManual: false, autoplay: true, playToken: s.playToken + 1 });
          return true;
        }
        return false;
      },

      jumpTo: (uid) => {
        const s = get();
        const mi = s.manual.findIndex((e) => e.uid === uid);
        if (mi >= 0) {
          set({ current: s.manual[mi], manual: s.manual.slice(mi + 1), currentFromManual: true, autoplay: true, playToken: s.playToken + 1 });
          return;
        }
        const ci = s.context.findIndex((e) => e.uid === uid);
        if (ci < 0) return;
        if (ci > s.pos + 1) {
          // Jumping ahead means skipping the songs in between on purpose: drop
          // them so they don't come back up in the queue.
          const skipped = new Set(s.context.slice(s.pos + 1, ci).map((e) => e.uid));
          const context = s.context.filter((e) => !skipped.has(e.uid));
          const pos = context.findIndex((e) => e.uid === uid);
          set({ context, original: s.original?.filter((e) => !skipped.has(e.uid)) ?? null, pos, current: context[pos], currentFromManual: false, autoplay: true, playToken: s.playToken + 1 });
          return;
        }
        set({ pos: ci, current: s.context[ci], currentFromManual: false, autoplay: true, playToken: s.playToken + 1 });
      },

      removeUpcoming: (uid) =>
        set((s) => {
          const ci = s.context.findIndex((e) => e.uid === uid);
          if (ci >= 0 && ci <= s.pos) return {}; // never remove current/past
          return {
            manual: s.manual.filter((e) => e.uid !== uid),
            context: s.context.filter((e) => e.uid !== uid),
            original: s.original?.filter((e) => e.uid !== uid) ?? null,
          };
        }),

      // Reorder within the visible "upcoming" list (manual items, then context after pos).
      moveUpcoming: (fromUid, toUid) =>
        set((s) => {
          const inManual = (u: string) => s.manual.some((e) => e.uid === u);
          if (inManual(fromUid) && inManual(toUid)) {
            const m = s.manual.slice();
            const from = m.findIndex((e) => e.uid === fromUid);
            const to = m.findIndex((e) => e.uid === toUid);
            const [it] = m.splice(from, 1);
            m.splice(to, 0, it);
            return { manual: m };
          }
          const c = s.context.slice();
          const from = c.findIndex((e) => e.uid === fromUid);
          const to = c.findIndex((e) => e.uid === toUid);
          if (from <= s.pos || to <= s.pos || from < 0 || to < 0) return {};
          const [it] = c.splice(from, 1);
          c.splice(to, 0, it);
          return { context: c };
        }),

      clearManual: () => set({ manual: [] }),
      clearUpcoming: () => set((s) => ({ manual: [], context: s.context.slice(0, s.pos + 1), original: null })),
      appendAuto: (tracks) =>
        set((s) => {
          const add = playable(tracks).map((track) => ({ uid: newUid(), track, auto: true }));
          return { context: [...s.context, ...add], original: s.original ? [...s.original, ...add] : null };
        }),
      insertAuto: (track, index) =>
        set((s) => {
          if (!track?.id) return {};
          const e = { uid: newUid(), track, auto: true };
          // Suggestions never jump in front of what the user chose.
          const i = Math.max(activeEnd(s.context, s.pos), Math.min(index, s.context.length));
          const context = [...s.context.slice(0, i), e, ...s.context.slice(i)];
          return { context, original: s.original ? [...s.original, e] : null };
        }),
      setAutoplayMode: (m) =>
        set((s) => {
          if (m !== "off") return { autoplayMode: m };
          // Turning it off drops suggestions not yet played.
          const keep = (e: QueueEntry, i: number) => !e.auto || i <= s.pos;
          return { autoplayMode: m, context: s.context.filter(keep), original: s.original?.filter((e) => !e.auto) ?? null };
        }),

      toggleShuffle: () =>
        set((s) => {
          const cur = s.context[s.pos];
          if (!s.shuffle) {
            const base = s.context;
            const rest = shuffled(base.filter((e) => e !== cur));
            return { shuffle: true, original: base, context: cur ? [cur, ...rest] : rest, pos: 0 };
          }
          const orig = s.original ?? s.context;
          const pos = Math.max(0, cur ? orig.findIndex((e) => e.uid === cur.uid) : 0);
          return { shuffle: false, original: null, context: orig, pos };
        }),
      cycleRepeat: () => set((s) => ({ repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off" })),
      setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)), muted: false }),
      toggleMute: () => set((s) => ({ muted: !s.muted })),

      patchTrack: (id, patch) =>
        set((s) => {
          const fix = (e: QueueEntry) => (e.track.id === id ? { ...e, track: { ...e.track, ...patch } } : e);
          return {
            context: s.context.map(fix),
            original: s.original?.map(fix) ?? null,
            manual: s.manual.map(fix),
            current: s.current ? fix(s.current) : null,
          };
        }),
      removeTrackEverywhere: (id) =>
        set((s) => {
          const keep = (e: QueueEntry) => e.track.id !== id || e.uid === s.current?.uid;
          const context = s.context.filter(keep);
          const curIdx = s.current ? context.findIndex((e) => e.uid === s.context[s.pos]?.uid) : 0;
          return { context, original: s.original?.filter(keep) ?? null, manual: s.manual.filter((e) => e.track.id !== id), pos: Math.max(0, curIdx) };
        }),

      setPanel: (p) => set({ panel: p }),
      togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
      setNp: (open, tab) => set((s) => ({ npOpen: open, npTab: tab ?? s.npTab })),
      setLyricsFull: (v) => set({ lyricsFull: v }),
    }),
    {
      name: "rii-player",
      version: 1,
      partialize: (s) => ({
        context: s.context,
        original: s.original,
        pos: s.pos,
        manual: s.manual,
        current: s.current,
        currentFromManual: s.currentFromManual,
        source: s.source,
        volume: s.volume,
        muted: s.muted,
        shuffle: s.shuffle,
        repeat: s.repeat,
        autoplayMode: s.autoplayMode,
        panel: s.panel,
      }),
    },
  ),
);

/** Upcoming entries as shown in the queue: manual first, then the rest of the context. */
export function upcoming(s: Pick<State, "manual" | "context" | "pos">) {
  return { manual: s.manual, fromContext: s.context.slice(s.pos + 1) };
}

// ── volatile playback state (not persisted; updates several times a second) ──

type Playback = {
  isPlaying: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  accent: string | null;
  error: string | null;
};

export const usePlayback = create<Playback>()(() => ({
  isPlaying: false,
  buffering: false,
  position: 0,
  duration: 0,
  accent: null,
  error: null,
}));
