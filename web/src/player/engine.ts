// Audio engine: two <audio> elements used in turn so the next track can be
// preloaded and crossfaded. In Web Audio mode each element runs through its own
// fade + normalisation GainNode into a master gain. "Simple mode" (default on
// iOS, where Web Audio can be cut when the screen locks) drives element.volume
// instead: no boost above 0 dB, but playback keeps going in the background.

import { api, coverUrl, streamUrl, type Settings } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { extractAccent } from "@/lib/accent";
import { usePlayback, usePlayer, type QueueEntry } from "./store";
import { notifyQueueEnded } from "./autofill";
import { t } from "@/i18n";

const PRELOAD_BEFORE = 15; // seconds before the end to load the next track
const FADE = 0.2; // pause/play/seek fade, seconds
const POS_KEY = "rii-pos";

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const SIMPLE_KEY = "rii-simple-audio";

export function getSimpleMode(): boolean {
  const v = localStorage.getItem(SIMPLE_KEY);
  return v === null ? isIOS : v === "1";
}

type Slot = {
  el: HTMLAudioElement;
  uid: string | null;
  fade?: GainNode;
  norm?: GainNode;
  // simple mode
  fadeVal: number;
  normVal: number;
  ramp?: { from: number; to: number; start: number; dur: number };
};

type Listen = { trackId: string; startedAt: number; played: number; lastT: number; source: string };

class Engine {
  private slots: [Slot, Slot];
  private active = 0;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private wave: Float32Array<ArrayBuffer> | null = null;
  private simple = getSimpleMode();
  private settings: Pick<Settings, "crossfadeSec" | "gaplessAlbum" | "normalize" | "discordPresence"> = { crossfadeSec: 4, gaplessAlbum: true, normalize: true, discordPresence: false };
  private npHeartbeat: number | null = null;
  private crossfading = false;
  private pendingFade = 0;
  private pauseToken = 0;
  private transition: "auto" | "crossfade" | null = null;
  private listen: Listen | null = null;
  private errorStreak = 0;
  private rampTimer: number | null = null;
  private lastPosSave = 0;
  private started = false;
  private npTimer: number | null = null;

  constructor() {
    const mk = (): Slot => {
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "use-credentials";
      return { el, uid: null, fadeVal: 1, normVal: 1 };
    };
    this.slots = [mk(), mk()];
    this.slots.forEach((s, i) => this.bind(s, i));
  }

  // ── setup ────────────────────────────────────────────────────────────

  init() {
    if (this.started) return;
    this.started = true;
    let prev = usePlayer.getState().current?.uid ?? null;
    let prevToken = usePlayer.getState().playToken;
    usePlayer.subscribe((s) => {
      const uid = s.current?.uid ?? null;
      if (uid !== prev || s.playToken !== prevToken) {
        const changed = uid !== prev;
        prev = uid;
        prevToken = s.playToken;
        this.onCurrentChange(s.current, s.autoplay, changed);
      }
      this.applyMaster();
    });
    this.restore();
    this.setupMediaSession();
    usePlayback.subscribe((s, prev) => {
      if (s.isPlaying !== prev.isPlaying) this.reportNowPlaying();
    });
    window.addEventListener("pagehide", () => this.savePosition(true));
  }

  /** Re-read track gains (a background loudness measurement just finished). */
  refreshNorm() {
    this.slots.forEach((s) => this.applyNorm(s));
  }

  configure(s: Partial<Settings>) {
    const presence = !!s.discordPresence && !this.settings.discordPresence;
    this.settings = { ...this.settings, ...s };
    this.applyNorm(this.slots[this.active]);
    if (presence) this.reportNowPlaying();
  }

  setSimpleMode(v: boolean) {
    localStorage.setItem(SIMPLE_KEY, v ? "1" : "0");
    // Switching away from Web Audio needs a fresh page: an element routed into a
    // MediaElementSource cannot be detached.
    location.reload();
  }
  /**
   * Current sound level for the music effect: bass (≈20–150 Hz, 0–1) and
   * overall loudness (RMS). Null in simple mode (no Web Audio).
   */
  levels(): { bass: number; rms: number } | null {
    const a = this.analyser;
    if (!a || !this.freq || !this.wave || !this.ctx) return null;
    a.getByteFrequencyData(this.freq);
    a.getFloatTimeDomainData(this.wave);
    const binHz = this.ctx.sampleRate / a.fftSize;
    const lo = Math.max(1, Math.floor(20 / binHz)), hi = Math.max(lo + 1, Math.ceil(150 / binHz));
    let b = 0;
    for (let i = lo; i < hi; i++) b += this.freq[i];
    let sq = 0;
    for (let i = 0; i < this.wave.length; i++) sq += this.wave[i] * this.wave[i];
    return { bass: b / (hi - lo) / 255, rms: Math.sqrt(sq / this.wave.length) };
  }

  get simpleMode() {
    return this.simple;
  }

  private ensureContext() {
    if (this.simple || this.ctx) {
      this.ctx?.state === "suspended" && this.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext({ latencyHint: "playback" });
      const master = ctx.createGain();
      master.connect(ctx.destination);
      // Music effect: tapped after loudness normalisation but before the
      // volume knob, so it follows the song's own dynamics, not the slider.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.55;
      this.analyser = analyser;
      this.freq = new Uint8Array(analyser.frequencyBinCount);
      this.wave = new Float32Array(analyser.fftSize);
      for (const s of this.slots) {
        const src = ctx.createMediaElementSource(s.el);
        s.fade = ctx.createGain();
        s.norm = ctx.createGain();
        src.connect(s.fade).connect(s.norm).connect(master);
        s.norm.connect(analyser);
        s.fade.gain.value = s.fadeVal;
      }
      this.ctx = ctx;
      this.master = master;
      this.applyMaster();
      this.slots.forEach((s) => this.applyNorm(s));
    } catch (e) {
      console.warn("Web Audio unavailable, using simple mode", e);
      this.simple = true;
    }
  }

  // ── gain helpers ─────────────────────────────────────────────────────

  private masterValue() {
    const p = usePlayer.getState();
    return p.muted ? 0 : p.volume * p.volume; // perceptual curve
  }

  private applyMaster() {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.masterValue(), this.ctx.currentTime, 0.02);
    } else {
      this.slots.forEach((s) => this.applySimpleVolume(s));
    }
  }

  private normFor(slot: Slot) {
    const entry = this.entryFor(slot.uid);
    if (!entry || !this.settings.normalize) return 1;
    return Math.pow(10, (entry.track.gainDb || 0) / 20);
  }

  private applyNorm(slot: Slot) {
    slot.normVal = this.normFor(slot);
    if (slot.norm && this.ctx) slot.norm.gain.setTargetAtTime(slot.normVal, this.ctx.currentTime, 0.05);
    else this.applySimpleVolume(slot);
  }

  private applySimpleVolume(slot: Slot) {
    if (this.ctx) return;
    slot.el.volume = Math.max(0, Math.min(1, slot.fadeVal * Math.min(1, slot.normVal) * this.masterValue()));
  }

  /** Ramp a slot's fade gain to `to` over `dur` seconds. */
  private rampFade(slot: Slot, to: number, dur: number) {
    if (slot.fade && this.ctx) {
      const g = slot.fade.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      if (dur <= 0) g.setValueAtTime(to, now);
      else g.linearRampToValueAtTime(to, now + dur);
      slot.fadeVal = to;
      return;
    }
    if (dur <= 0) {
      slot.ramp = undefined;
      slot.fadeVal = to;
      this.applySimpleVolume(slot);
      return;
    }
    slot.ramp = { from: slot.fadeVal, to, start: performance.now(), dur: dur * 1000 };
    if (this.rampTimer == null) {
      this.rampTimer = window.setInterval(() => {
        let busy = false;
        for (const s of this.slots) {
          if (!s.ramp) continue;
          const k = Math.min(1, (performance.now() - s.ramp.start) / s.ramp.dur);
          s.fadeVal = s.ramp.from + (s.ramp.to - s.ramp.from) * k;
          this.applySimpleVolume(s);
          if (k >= 1) s.ramp = undefined;
          else busy = true;
        }
        if (!busy && this.rampTimer != null) {
          clearInterval(this.rampTimer);
          this.rampTimer = null;
        }
      }, 30);
    }
  }

  private wait(sec: number) {
    return new Promise((r) => setTimeout(r, sec * 1000));
  }

  // ── element events ───────────────────────────────────────────────────

  private bind(slot: Slot, idx: number) {
    const el = slot.el;
    const isActive = () => this.active === idx;
    el.addEventListener("timeupdate", () => {
      if (!isActive()) return;
      this.onTime(el.currentTime);
    });
    el.addEventListener("durationchange", () => {
      if (isActive() && isFinite(el.duration)) usePlayback.setState({ duration: el.duration });
    });
    el.addEventListener("playing", () => {
      if (!isActive()) return;
      this.errorStreak = 0;
      usePlayback.setState({ isPlaying: true, buffering: false, error: null });
      this.updatePositionState();
    });
    el.addEventListener("pause", () => {
      if (isActive() && !this.crossfading) usePlayback.setState({ isPlaying: false });
    });
    el.addEventListener("waiting", () => isActive() && usePlayback.setState({ buffering: true }));
    el.addEventListener("canplay", () => isActive() && usePlayback.setState({ buffering: false }));
    el.addEventListener("ended", () => isActive() && this.onEnded());
    el.addEventListener("error", () => {
      if (!isActive() || !el.src) return;
      this.onError();
    });
  }

  private onTime(t: number) {
    usePlayback.setState({ position: t });
    const l = this.listen;
    if (l) {
      const d = t - l.lastT;
      if (d > 0 && d < 2) l.played += d;
      l.lastT = t;
    }
    if (performance.now() - this.lastPosSave > 5000) this.savePosition();

    const slot = this.slots[this.active];
    const dur = slot.el.duration;
    if (!isFinite(dur) || dur <= 0) return;
    const remaining = dur - t;
    const p = usePlayer.getState();
    if (p.repeat === "one") return;
    const next = p.peekNext();
    if (!next) return;
    const other = this.slots[1 - this.active];
    if (remaining <= PRELOAD_BEFORE && other.uid !== next.uid) this.preload(other, next);
    const cf = this.crossfadeFor(p.current, next);
    if (cf > 0 && remaining <= cf && !this.crossfading && !slot.el.paused && other.uid === next.uid) {
      this.startCrossfade(cf);
    }
  }

  private crossfadeFor(cur: QueueEntry | null, next: QueueEntry) {
    const cf = this.settings.crossfadeSec;
    if (cf <= 0 || !cur) return 0;
    if (this.simple && isIOS) return 0; // element.volume is read-only on iOS
    const a = cur.track, b = next.track;
    if (this.settings.gaplessAlbum && a.album && a.album === b.album && a.artist === b.artist) return 0;
    return Math.min(cf, (a.durationMs / 1000) / 3, (b.durationMs / 1000) / 3);
  }

  private preload(slot: Slot, entry: QueueEntry) {
    slot.uid = entry.uid;
    slot.el.src = streamUrl(entry.track.id);
    slot.el.load();
    this.rampFade(slot, 0, 0);
    this.applyNorm(slot);
  }

  private startCrossfade(dur: number) {
    this.crossfading = true;
    this.pendingFade = dur;
    this.transition = "crossfade";
    usePlayer.getState().advance(); // → onCurrentChange swaps slots
    window.setTimeout(() => (this.crossfading = false), dur * 1000 + 100);
  }

  private onEnded() {
    const p = usePlayer.getState();
    if (p.repeat === "one" && p.current) {
      this.logListen("repeat");
      this.beginListen(p.current);
      const el = this.slots[this.active].el;
      el.currentTime = 0;
      el.play().catch(() => {});
      return;
    }
    this.transition = "auto";
    if (!p.advance()) {
      notifyQueueEnded(); // autoplay may still be downloading the next one
      this.logListen("finish");
      usePlayback.setState({ isPlaying: false, position: 0 });
      this.slots[this.active].el.currentTime = 0;
      this.transition = null;
      this.savePosition(true);
    }
  }

  private onError() {
    const p = usePlayer.getState();
    this.errorStreak++;
    const name = p.current?.track.title ?? "";
    usePlayback.setState({ isPlaying: false, buffering: false, error: t("ui.player.playError") });
    toast(t("ui.player.playErrorToast", { title: name }), "error");
    if (this.errorStreak < 3) {
      this.transition = "auto";
      window.setTimeout(() => {
        if (!p.advance()) this.transition = null;
      }, 800);
    }
  }

  // ── current track changes ────────────────────────────────────────────

  private entryFor(uid: string | null): QueueEntry | null {
    if (!uid) return null;
    const p = usePlayer.getState();
    if (p.current?.uid === uid) return p.current;
    return p.manual.find((e) => e.uid === uid) ?? p.context.find((e) => e.uid === uid) ?? null;
  }

  private onCurrentChange(entry: QueueEntry | null, autoplay: boolean, changed: boolean) {
    const reason = this.transition;
    this.transition = null;
    if (changed || autoplay) this.logListen(reason === "auto" || reason === "crossfade" ? "finish" : "skip");

    const cur = this.slots[this.active];
    const other = this.slots[1 - this.active];

    if (!entry) {
      cur.el.pause();
      cur.el.removeAttribute("src");
      cur.uid = null;
      usePlayback.setState({ isPlaying: false, position: 0, duration: 0 });
      this.updateMediaSession(null);
      return;
    }

    this.updateMediaSession(entry);
    this.updateAccent(entry);
    this.reportNowPlaying();
    usePlayback.setState({ position: 0, duration: entry.track.durationMs / 1000, error: null });

    if (!changed && cur.uid === entry.uid) {
      // same track, explicit replay request
      cur.el.currentTime = 0;
      this.play();
      this.beginListen(entry);
      return;
    }

    if (other.uid === entry.uid && other.el.src) {
      // Next track is preloaded: swap slots.
      this.ensureContext();
      this.active = 1 - this.active;
      const fadeIn = reason === "crossfade" ? this.pendingFade : 0;
      this.pendingFade = 0;
      other.el.currentTime = 0;
      this.applyNorm(other);
      this.rampFade(other, fadeIn > 0 ? 0 : 1, 0);
      other.el.play().catch((e) => this.playRejected(e));
      if (fadeIn > 0) {
        this.rampFade(other, 1, fadeIn);
        this.rampFade(cur, 0, fadeIn);
        window.setTimeout(() => {
          if (this.slots[this.active] !== cur) {
            cur.el.pause();
            cur.uid = null;
          }
        }, fadeIn * 1000 + 50);
      } else {
        cur.el.pause();
        cur.uid = null;
      }
      this.beginListen(entry);
      return;
    }

    // Fresh load.
    if (other.uid) {
      other.el.pause();
      other.uid = null;
      other.el.removeAttribute("src");
    }
    cur.uid = entry.uid;
    cur.el.src = streamUrl(entry.track.id);
    this.applyNorm(cur);
    if (autoplay) {
      this.rampFade(cur, 1, 0);
      this.play(false);
    } else {
      cur.el.load();
    }
    this.beginListen(entry);
  }

  private playRejected(e: unknown) {
    if ((e as DOMException)?.name === "NotAllowedError") {
      usePlayback.setState({ isPlaying: false });
    } else if ((e as DOMException)?.name !== "AbortError") {
      console.warn(e);
    }
  }

  // ── listen logging ───────────────────────────────────────────────────

  private beginListen(entry: QueueEntry) {
    const src = usePlayer.getState().source;
    this.listen = { trackId: entry.track.id, startedAt: Date.now(), played: 0, lastT: 0, source: src ? `${src.type}:${src.id ?? ""}` : "" };
  }

  private logListen(action: "finish" | "skip" | "repeat") {
    const l = this.listen;
    this.listen = null;
    if (!l || l.played < 1) return;
    api("/api/events/listen", {
      method: "POST",
      keepalive: true,
      json: { trackId: l.trackId, playedMs: Math.round(l.played * 1000), action, source: l.source, startedAt: l.startedAt, hour: new Date(l.startedAt).getHours() },
    }).catch(() => {});
  }

  // ── public controls ──────────────────────────────────────────────────

  async play(fade = true) {
    const p = usePlayer.getState();
    if (!p.current) return;
    this.ensureContext();
    const slot = this.slots[this.active];
    this.pauseToken++;
    if (slot.uid !== p.current.uid || !slot.el.src) {
      slot.uid = p.current.uid;
      slot.el.src = streamUrl(p.current.track.id);
      this.applyNorm(slot);
    }
    if (!this.listen) this.beginListen(p.current);
    if (fade) this.rampFade(slot, 0, 0);
    try {
      await slot.el.play();
      if (fade) this.rampFade(slot, 1, FADE);
      else this.rampFade(slot, 1, 0);
    } catch (e) {
      this.playRejected(e);
    }
  }

  async pause() {
    const slot = this.slots[this.active];
    if (slot.el.paused) return;
    const token = ++this.pauseToken;
    this.rampFade(slot, 0, FADE);
    usePlayback.setState({ isPlaying: false });
    await this.wait(FADE);
    if (token !== this.pauseToken) return; // play() was pressed during the fade
    slot.el.pause();
    this.savePosition(true);
  }

  toggle() {
    const slot = this.slots[this.active];
    if (!usePlayer.getState().current) return;
    if (slot.el.paused || !slot.el.src) this.play();
    else this.pause();
  }

  async seek(t: number) {
    const slot = this.slots[this.active];
    const el = slot.el;
    if (!isFinite(t)) return;
    const dur = isFinite(el.duration) ? el.duration : usePlayback.getState().duration;
    t = Math.max(0, Math.min(t, Math.max(0, dur - 0.25)));
    if (this.listen) this.listen.lastT = t;
    usePlayback.setState({ position: t });
    if (el.paused) {
      el.currentTime = t;
      this.savePosition(true);
      return;
    }
    this.rampFade(slot, 0, 0.08);
    await this.wait(0.08);
    el.currentTime = t;
    this.rampFade(slot, 1, 0.15);
    this.updatePositionState();
    this.reportNowPlaying();
  }

  seekBy(d: number) {
    this.seek(this.slots[this.active].el.currentTime + d);
  }

  next() {
    this.transition = null;
    if (!usePlayer.getState().advance()) toast(t("ui.player.endOfQueue"));
  }

  prev() {
    const el = this.slots[this.active].el;
    if (el.currentTime > 3) {
      this.seek(0);
      return;
    }
    this.transition = null;
    if (!usePlayer.getState().back()) this.seek(0);
  }

  // ── persistence ──────────────────────────────────────────────────────

  private savePosition(force = false) {
    const p = usePlayer.getState();
    if (!p.current) return;
    if (!force && performance.now() - this.lastPosSave < 5000) return;
    this.lastPosSave = performance.now();
    localStorage.setItem(POS_KEY, JSON.stringify({ uid: p.current.uid, t: this.slots[this.active].el.currentTime || usePlayback.getState().position }));
  }

  private restore() {
    const p = usePlayer.getState();
    if (!p.current) return;
    const slot = this.slots[this.active];
    slot.uid = p.current.uid;
    slot.el.src = streamUrl(p.current.track.id);
    this.applyNorm(slot);
    this.updateMediaSession(p.current);
    this.updateAccent(p.current);
    usePlayback.setState({ duration: p.current.track.durationMs / 1000 });
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (saved?.uid === p.current.uid && saved.t > 0) {
        usePlayback.setState({ position: saved.t });
        slot.el.addEventListener("loadedmetadata", () => (slot.el.currentTime = saved.t), { once: true });
      }
    } catch {
      /* ignore */
    }
  }

  // ── Media Session & accent ───────────────────────────────────────────

  private setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const h = (a: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(a, fn);
      } catch {
        /* unsupported action */
      }
    };
    h("play", () => this.play());
    h("pause", () => this.pause());
    h("previoustrack", () => this.prev());
    h("nexttrack", () => this.next());
    h("seekto", (d) => d.seekTime != null && this.seek(d.seekTime));
    // iOS shows ±10 s buttons instead of previous / next when these exist.
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!ios) {
      h("seekbackward", (d) => this.seekBy(-(d.seekOffset ?? 10)));
      h("seekforward", (d) => this.seekBy(d.seekOffset ?? 10));
    }
    h("stop", () => this.pause());
    // Play / pause state of the notification, lock screen and media keys.
    const sync = (playing: boolean) => {
      ms.playbackState = usePlayer.getState().current ? (playing ? "playing" : "paused") : "none";
    };
    usePlayback.subscribe((s, prev) => {
      if (s.isPlaying !== prev.isPlaying) {
        sync(s.isPlaying);
        this.updatePositionState();
      }
      if (s.duration !== prev.duration) this.updatePositionState();
    });
  }

  private updateMediaSession(entry: QueueEntry | null) {
    const ms = navigator.mediaSession;
    if (!ms) return;
    if (!entry) {
      ms.metadata = null;
      ms.playbackState = "none";
      return;
    }
    const t = entry.track;
    const src = new URL(t.hasCover ? coverUrl(t.id) : "/icon-512.png", location.href).href;
    const art = t.hasCover
      ? ["96x96", "256x256", "512x512", "720x720"].map((sizes) => ({ src, sizes, type: "image/jpeg" }))
      : [{ src, sizes: "512x512", type: "image/png" }];
    ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art });
    document.title = `${t.title}${t.artist ? " · " + t.artist : ""} — ${window.__RII_BRAND__?.name ?? "RiiMusic"}`;
  }

  /**
   * Announce what is playing as a window event ("riimusic:nowplaying"), debounced.
   * A desktop wrapper (Tauri) can listen to it to show Discord presence.
   */
  private reportNowPlaying() {
    if (this.npTimer) clearTimeout(this.npTimer);
    this.npTimer = window.setTimeout(() => {
      const cur = usePlayer.getState().current;
      const pb = usePlayback.getState();
      const t = cur?.track;
      const positionMs = Math.round((this.slots[this.active].el.currentTime || pb.position) * 1000);
      window.dispatchEvent(
        new CustomEvent("riimusic:nowplaying", {
          detail: t ? { trackId: t.id, title: t.title, artist: t.artist, album: t.album, durationMs: t.durationMs, positionMs, playing: pb.isPlaying } : null,
        }),
      );
      // Discord presence (Cài đặt → Trạng thái Discord): the server keeps it for the desktop agent.
      if (this.settings.discordPresence) {
        api("/api/nowplaying", { method: "POST", keepalive: true, json: { trackId: t?.id ?? "", positionMs, playing: pb.isPlaying } }).catch(() => {});
      }
    }, 800);
    if (this.npHeartbeat) clearInterval(this.npHeartbeat);
    if (this.settings.discordPresence && usePlayback.getState().isPlaying) this.npHeartbeat = window.setInterval(() => this.reportNowPlaying(), 60_000);
  }

  private updatePositionState() {
    const el = this.slots[this.active].el;
    const ms = navigator.mediaSession;
    if (!ms?.setPositionState || !isFinite(el.duration)) return;
    try {
      ms.setPositionState({ duration: el.duration, position: Math.min(el.currentTime, el.duration), playbackRate: el.playbackRate });
    } catch {
      /* ignore */
    }
  }

  private updateAccent(entry: QueueEntry) {
    if (!entry.track.hasCover) {
      usePlayback.setState({ accent: null });
      return;
    }
    extractAccent(coverUrl(entry.track.id)).then((c) => {
      if (usePlayer.getState().current?.uid === entry.uid) usePlayback.setState({ accent: c });
    });
  }
}

export const engine = new Engine();
