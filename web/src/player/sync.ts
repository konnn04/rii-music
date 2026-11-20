// One player at a time across a user's tabs and devices.
//  - Tabs of this browser: the tab that starts playing tells the others
//    (BroadcastChannel); they pause.
//  - Devices: each reports its playback to the server (POST /api/playback);
//    the server relays it to the user's other devices over SSE ("playback").
//    A device that was playing pauses and offers "Phát ở đây": the same song,
//    position and queue continue on this device.

import { create } from "zustand";
import { api, type Track } from "@/lib/api";
import { usePlayback, usePlayer, type QueueEntry } from "./store";
import { engine } from "./engine";

export type RemoteSession = {
  deviceId: string;
  deviceName: string;
  trackId: string;
  positionMs: number;
  playing: boolean;
  upcoming: string[];
  sourceName: string;
  updatedAt: number;
};

/** The latest session from another device (null when this device is the active one). */
export const useRemote = create<{ session: RemoteSession | null; title: string }>(() => ({ session: null, title: "" }));

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

function upcoming(): string[] {
  const s = usePlayer.getState();
  const rest: QueueEntry[] = [...s.manual, ...s.context.slice(s.pos + 1)];
  return rest.slice(0, 100).map((e) => e.track.id);
}

function report(force = false) {
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
  };
  const key = `${body.trackId}|${body.playing}|${Math.round(body.positionMs / 5000)}`;
  if (!force && key === lastSent) return;
  lastSent = key;
  api("/api/playback", { method: "POST", json: body, keepalive: true }).catch(() => {});
}

/** Fed from the SSE "playback" event. */
export function onRemotePlayback(p: RemoteSession) {
  if (p.deviceId === deviceId) return;
  if (p.playing && usePlayback.getState().isPlaying) engine.pause(); // another device took over
  if (!p.trackId) return useRemote.setState({ session: null, title: "" });
  useRemote.setState({ session: p });
  // Title for the banner (the track may not be in this device's cache yet).
  const local = [usePlayer.getState().current, ...usePlayer.getState().context].find((e) => e?.track.id === p.trackId);
  if (local) useRemote.setState({ title: local.track.title });
  else api<Track>(`/api/tracks/${p.trackId}`).then((t) => useRemote.setState({ title: t.title }), () => {});
}

/** "Phát ở đây": continue the other device's session on this one. */
export async function takeOver() {
  const r = await api<{ session: RemoteSession | null; tracks: Track[] }>("/api/playback");
  if (!r.session || !r.tracks.length) return;
  const s = r.session;
  usePlayer.getState().playList(r.tracks, 0, { type: "queue", name: s.sourceName || s.deviceName }, { shuffle: false });
  useRemote.setState({ session: null, title: "" });
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
  useRemote.setState({ session: null, title: "" });
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
        useRemote.setState({ session: null, title: "" }); // this device is the active one now
      }
      report(true);
    } else if (s.isPlaying && Math.abs(s.position - prev.position) > 3) {
      report(); // a seek
    }
  });
  usePlayer.subscribe((s, prev) => {
    if (s.current?.uid !== prev.current?.uid) report(true);
  });
  // Heartbeat while playing, so other devices know this one is still on.
  timer = window.setInterval(() => {
    if (usePlayback.getState().isPlaying) report(true);
  }, 30_000);
  // On start: show the last session of another device, to continue it here.
  api<{ session: RemoteSession | null }>("/api/playback")
    .then((r) => {
      if (r.session && r.session.deviceId !== deviceId && !usePlayer.getState().current) onRemotePlayback(r.session);
    })
    .catch(() => {});
}

export function stopSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
