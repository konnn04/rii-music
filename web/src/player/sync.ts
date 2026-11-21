// One player at a time across a user's tabs and devices, and remote control.
//  - Tabs of this browser: the tab that starts playing tells the others
//    (BroadcastChannel); they pause.
//  - Devices: each reports its playback to the server (POST /api/playback);
//    the server relays it to the user's other devices over SSE ("playback").
//    A device that was playing pauses and offers "Phát ở đây": the same song,
//    position and queue continue on this device.
//  - Remote control (like Spotify Connect): the other devices see what the
//    playing one plays (song, progress, volume, queue) and send it commands
//    (POST /api/playback/command → SSE "remote-cmd" to that device).

import { create } from "zustand";
import { api, type Track } from "@/lib/api";
import { usePlayback, usePlayer, type QueueEntry, type Repeat } from "./store";
import { engine } from "./engine";

export type RemoteSession = {
  deviceId: string;
  deviceName: string;
  trackId: string;
  positionMs: number;
  playing: boolean;
  upcoming: string[];
  sourceName: string;
  durationMs: number;
  volume: number;
  shuffle: boolean;
  repeat: Repeat;
  updatedAt: number;
  /** Local time the report arrived (the server clock may differ). */
  receivedAt: number;
};

export type RemoteCmd =
  | { cmd: "play" | "pause" | "toggle" | "next" | "prev" | "shuffle" | "repeat" | "takeOver" }
  | { cmd: "seek"; positionMs: number }
  | { cmd: "volume"; volume: number }
  | { cmd: "jump" | "remove"; index: number; trackId: string }
  | { cmd: "move"; index: number; to: number; trackId: string }
  | { cmd: "playNow" | "queue"; trackIds: string[] };

type RemoteState = {
  /** The session of another device (null when this device is the active one). */
  session: RemoteSession | null;
  title: string;
  /** The remote's current song followed by its upcoming songs (for the remote queue). */
  tracks: Track[];
};

export const useRemote = create<RemoteState>(() => ({ session: null, title: "", tracks: [] }));

export const deviceId = (() => {
  let id = localStorage.getItem("rii-device");
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem("rii-device", id);
  }
  return id;
})();

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" · ") || "Trình duyệt";
}

const tabId = Math.random().toString(36).slice(2);
let bc: BroadcastChannel | null = null;
let started = false;
let timer: number | null = null;
let lastSent = "";

function upcomingEntries(): QueueEntry[] {
  const s = usePlayer.getState();
  return [...s.manual, ...s.context.slice(s.pos + 1)];
}

function upcoming(): string[] {
  return upcomingEntries()
    .slice(0, 100)
    .map((e) => e.track.id);
}

function report(force = false): Promise<unknown> {
  const s = usePlayer.getState();
  const pb = usePlayback.getState();
  const body = {
    deviceId,
    deviceName: deviceName(),
    trackId: s.current?.track.id ?? "",
    positionMs: Math.round((pb.position || 0) * 1000),
    playing: pb.isPlaying,
    upcoming: upcoming(),
    sourceName: s.source?.name ?? "",
    durationMs: Math.round((pb.duration || 0) * 1000),
    volume: s.muted ? 0 : s.volume,
    shuffle: s.shuffle,
    repeat: s.repeat,
  };
  const key = [body.trackId, body.playing, Math.round(body.positionMs / 5000), body.volume.toFixed(2), body.shuffle, body.repeat, body.upcoming.join(",")].join("|");
  if (!force && key === lastSent) return Promise.resolve();
  lastSent = key;
  return api("/api/playback", { method: "POST", json: body, keepalive: true }).catch(() => {});
}

// ── devices ("chọn thiết bị phát") ───────────────────────────────────────

export type Device = { deviceId: string; deviceName: string; active: boolean; playing: boolean; lastSeen: number };

/** This app is open: lets other devices pick it as the player. */
function announce() {
  void api("/api/devices", { method: "POST", json: { deviceId, deviceName: deviceName() } }).catch(() => {});
}

export function listDevices(): Promise<Device[]> {
  return api<Device[]>("/api/devices");
}

/** Play on that device: the same song, position and queue continue there. */
export async function transferTo(target: string) {
  if (target === deviceId) return takeOver();
  if (usePlayback.getState().isPlaying || usePlayer.getState().current) await report(true); // the session the target picks up
  await api("/api/playback/command", { method: "POST", json: { cmd: "takeOver", target, from: deviceId } });
}

// ── watching another device ──────────────────────────────────────────────

let tracksFor = "";

/** Forget the other device's session (and the songs loaded for it). */
function clearRemote() {
  tracksFor = "";
  useRemote.setState({ session: null, title: "", tracks: [] });
}

/** Fed from the SSE "playback" event. */
export function onRemotePlayback(p: Omit<RemoteSession, "receivedAt">) {
  if (p.deviceId === deviceId) return;
  if (p.playing && usePlayback.getState().isPlaying) engine.pause(); // another device took over
  if (!p.trackId) return clearRemote();
  // A paused session elsewhere matters only while this device isn't playing.
  if (!p.playing && usePlayback.getState().isPlaying) return;
  const session: RemoteSession = { ...p, upcoming: p.upcoming ?? [], volume: p.volume ?? 1, repeat: p.repeat ?? "off", durationMs: p.durationMs ?? 0, receivedAt: Date.now() };
  useRemote.setState({ session });
  // Titles and covers for the remote view (the tracks may not be cached here).
  const want = [p.trackId, ...session.upcoming].join(",");
  if (want !== tracksFor) {
    tracksFor = want;
    api<{ tracks: Track[] }>("/api/playback").then(
      (r) => {
        if (tracksFor !== want) return;
        const tracks = r.tracks ?? [];
        useRemote.setState({ tracks, title: tracks.find((t) => t.id === p.trackId)?.title ?? "" });
      },
      () => {},
    );
  }
}

/** Where the remote song is now, in ms (extrapolated while it plays). */
export function remotePositionMs(s: RemoteSession, now = Date.now()): number {
  if (!s.playing) return s.positionMs;
  const p = s.positionMs + (now - s.receivedAt);
  return s.durationMs > 0 ? Math.min(p, s.durationMs) : p;
}

/** Send a command to the device that is playing; the view updates at once. */
export function remoteCommand(c: RemoteCmd) {
  const s = useRemote.getState().session;
  if (!s) return Promise.resolve();
  const now = Date.now();
  // Optimistic: show the change before the device reports back.
  const patch: Partial<RemoteSession> = {};
  if (c.cmd === "play") patch.playing = true;
  if (c.cmd === "pause") patch.playing = false;
  if (c.cmd === "toggle") patch.playing = !s.playing;
  if (c.cmd === "play" || c.cmd === "pause" || c.cmd === "toggle") Object.assign(patch, { positionMs: remotePositionMs(s, now), receivedAt: now });
  if (c.cmd === "seek") Object.assign(patch, { positionMs: c.positionMs, receivedAt: now });
  if (c.cmd === "volume") patch.volume = c.volume;
  if (c.cmd === "remove") patch.upcoming = s.upcoming.filter((_, i) => i !== c.index);
  useRemote.setState({ session: { ...s, ...patch } });
  return api("/api/playback/command", { method: "POST", json: { ...c, target: s.deviceId, from: deviceId } }).catch(() => {});
}

/** Fed from the SSE "remote-cmd" event: run it if it is for this device. */
export async function onRemoteCommand(c: RemoteCmd & { target: string; from: string }) {
  if (c.target !== deviceId || c.from === deviceId) return;
  const p = usePlayer.getState();
  const at = (i: number, id: string) => {
    const e = upcomingEntries()[i];
    return e && e.track.id === id ? e : null;
  };
  switch (c.cmd) {
    case "play":
      await engine.play();
      break;
    case "pause":
      await engine.pause();
      break;
    case "toggle":
      engine.toggle();
      break;
    case "next":
      engine.next();
      break;
    case "prev":
      engine.prev();
      break;
    case "seek":
      await engine.seek(c.positionMs / 1000);
      break;
    case "volume":
      p.setVolume(c.volume);
      break;
    case "shuffle":
      p.toggleShuffle();
      break;
    case "repeat":
      p.cycleRepeat();
      break;
    case "jump": {
      const e = at(c.index, c.trackId);
      if (e) p.jumpTo(e.uid);
      break;
    }
    case "remove": {
      const e = at(c.index, c.trackId);
      if (e) p.removeUpcoming(e.uid);
      break;
    }
    case "move": {
      const e = at(c.index, c.trackId);
      const to = upcomingEntries()[c.to];
      if (e && to) p.moveUpcoming(e.uid, to.uid);
      break;
    }
    case "takeOver":
      await takeOver();
      return;
    case "playNow":
    case "queue": {
      const tracks = (await Promise.all(c.trackIds.map((id) => api<Track>(`/api/tracks/${id}`).catch(() => null)))).filter((t): t is Track => !!t);
      if (!tracks.length) break;
      if (c.cmd === "playNow") usePlayer.getState().playList(tracks, 0, { type: "queue", name: "Điều khiển từ xa" }, { shuffle: false });
      else usePlayer.getState().addToQueue(tracks);
      break;
    }
  }
  void report(true);
}

/** "Phát ở đây": continue the other device's session on this one. */
export async function takeOver() {
  const r = await api<{ session: RemoteSession | null; tracks: Track[] }>("/api/playback");
  if (!r.session || !r.tracks.length) return;
  const s = r.session;
  // Ask the other device to stop (it also pauses when this one starts playing).
  if (s.deviceId !== deviceId) void api("/api/playback/command", { method: "POST", json: { cmd: "pause", target: s.deviceId, from: deviceId } }).catch(() => {});
  usePlayer.getState().playList(r.tracks, 0, { type: "queue", name: s.sourceName || s.deviceName }, { shuffle: false });
  clearRemote();
  // Seek once the engine has loaded the song.
  const want = s.positionMs / 1000;
  if (want > 2) {
    const unsub = usePlayback.subscribe((pb) => {
      if (pb.duration > 0) {
        unsub();
        void engine.seek(Math.min(want, pb.duration - 1));
      }
    });
  }
}

export function dismissRemote() {
  clearRemote();
}

export function startSync() {
  if (started) return;
  started = true;
  if ("BroadcastChannel" in window) {
    bc = new BroadcastChannel("rii-player");
    bc.onmessage = (e) => {
      if (e.data?.type === "playing" && e.data.tab !== tabId && usePlayback.getState().isPlaying) engine.pause();
    };
  }
  usePlayback.subscribe((s, prev) => {
    if (s.isPlaying !== prev.isPlaying) {
      if (s.isPlaying) {
        bc?.postMessage({ type: "playing", tab: tabId });
        clearRemote(); // this device is the active one now
      }
      void report(true);
    } else if (s.isPlaying && Math.abs(s.position - prev.position) > 3) {
      void report(); // a seek
    } else if (s.duration !== prev.duration && s.duration > 0) {
      void report();
    }
  });
  usePlayer.subscribe((s, prev) => {
    if (s.current?.uid !== prev.current?.uid) void report(true);
    else if (
      s.volume !== prev.volume ||
      s.muted !== prev.muted ||
      s.shuffle !== prev.shuffle ||
      s.repeat !== prev.repeat ||
      s.manual !== prev.manual ||
      s.context !== prev.context ||
      s.pos !== prev.pos
    ) {
      // Volume and queue changes, for remotes watching this device.
      if (usePlayback.getState().isPlaying) void report();
    }
  });
  // Heartbeat while playing, so other devices know this one is still on; and
  // "this app is open" so it shows in the device picker.
  announce();
  timer = window.setInterval(() => {
    if (usePlayback.getState().isPlaying) void report(true);
    announce();
  }, 30_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && announce());
  // On start: show what another device is playing (to control it or continue it here).
  api<{ session: Omit<RemoteSession, "receivedAt"> | null }>("/api/playback")
    .then((r) => {
      if (r.session && r.session.deviceId !== deviceId && (r.session.playing || !usePlayer.getState().current)) onRemotePlayback(r.session);
    })
    .catch(() => {});
}

export function stopSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
