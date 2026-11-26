// One player bar for "this device" and "another device" (like Spotify Connect):
// while another device of the user plays, the bar shows that device's song and
// its buttons send remote commands; otherwise they drive the local engine.

import { useEffect, useState } from "react";
import { create } from "zustand";
import type { Track } from "@/lib/api";
import { engine } from "./engine";
import { setRemoteRouter, usePlayback, usePlayer, type Repeat } from "./store";
import { remoteCommand, remotePositionMs, useRemote, type RemoteSession } from "./sync";

/**
 * The remote session the bar should show, or null when this device leads.
 * Once another device is the player, the bar keeps controlling it, paused or
 * not, until this device plays something itself (like Spotify Connect).
 */
export function useRemoteView(): RemoteSession | null {
  const session = useRemote((r) => r.session);
  const localPlaying = usePlayback((s) => s.isPlaying);
  return session && !localPlaying ? session : null;
}

/** Non-hook version of useRemoteView. */
export const remoteNow = () => {
  const s = useRemote.getState().session;
  return s && !usePlayback.getState().isPlaying ? s : null;
};

// While another device leads, picking a song or adding to the queue here goes to
// that device (the user moves playback with the device picker or "Phát ở đây").
setRemoteRouter((kind, tracks) => {
  if (!remoteNow() || !tracks.length) return false;
  const trackIds = tracks.slice(0, 200).map((t) => t.id);
  void remoteCommand({ cmd: kind === "play" ? "playNow" : kind === "next" ? "playNext" : "queue", trackIds });
  return true;
});

/** What the bar shows, outside React (desktop tray, mini player, Discord). */
export function viewNow(): { track: Track | null; playing: boolean; position: number; duration: number } {
  const r = remoteNow();
  if (r) {
    const st = useRemote.getState();
    const p = usePlayer.getState();
    const track =
      st.tracks.find((t) => t.id === r.trackId) ??
      [p.current, ...p.context, ...p.manual].find((e) => e?.track.id === r.trackId)?.track ??
      null;
    return { track, playing: r.playing, position: remotePositionMs(r) / 1000, duration: r.durationMs / 1000 };
  }
  const pb = usePlayback.getState();
  return { track: usePlayer.getState().current?.track ?? null, playing: pb.isPlaying, position: pb.position, duration: pb.duration };
}

/** The song on the bar. */
export function useViewTrack(): Track | null {
  const remote = useRemoteView();
  const remoteTrack = useRemote((r) => r.tracks.find((t) => t.id === r.session?.trackId) ?? null);
  const local = usePlayer((s) => s.current?.track ?? null);
  const known = usePlayer((s) => {
    // The remote song's details before /api/playback answered: from this device's queue.
    const id = useRemote.getState().session?.trackId;
    return id ? ([s.current, ...s.context, ...s.manual].find((e) => e?.track.id === id)?.track ?? null) : null;
  });
  return remote ? (remoteTrack ?? known) : local;
}

export function useViewPlaying(): boolean {
  const remote = useRemoteView();
  const local = usePlayback((s) => s.isPlaying);
  return remote ? remote.playing : local;
}

/** Position and duration in seconds (the remote one ticks while it plays). */
export function useViewTime(): { position: number; duration: number } {
  const remote = useRemoteView();
  const position = usePlayback((s) => s.position);
  const duration = usePlayback((s) => s.duration);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!remote?.playing) return;
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [remote?.playing]);
  if (remote) return { position: remotePositionMs(remote) / 1000, duration: remote.durationMs / 1000 };
  return { position, duration };
}

export function useViewVolume(): { volume: number; muted: boolean } {
  const remote = useRemoteView();
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  if (remote) return { volume: remote.volume, muted: remote.volume === 0 };
  return { volume, muted };
}

export function useViewModes(): { shuffle: boolean; repeat: Repeat } {
  const remote = useRemoteView();
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  if (remote) return { shuffle: remote.shuffle, repeat: remote.repeat };
  return { shuffle, repeat };
}

let lastRemoteVolume = 1;

/** Buttons of the bar: the remote device when it leads, else this one. */
export const ctl = {
  toggle: () => (remoteNow() ? void remoteCommand({ cmd: "toggle" }) : engine.toggle()),
  next: () => (remoteNow() ? void remoteCommand({ cmd: "next" }) : engine.next()),
  prev: () => (remoteNow() ? void remoteCommand({ cmd: "prev" }) : engine.prev()),
  seek: (sec: number) => (remoteNow() ? void remoteCommand({ cmd: "seek", positionMs: Math.round(sec * 1000) }) : void engine.seek(sec)),
  setVolume: (v: number) => (remoteNow() ? void remoteCommand({ cmd: "volume", volume: v }) : usePlayer.getState().setVolume(v)),
  toggleMute: () => {
    const r = remoteNow();
    if (!r) return usePlayer.getState().toggleMute();
    if (r.volume > 0) lastRemoteVolume = r.volume;
    void remoteCommand({ cmd: "volume", volume: r.volume > 0 ? 0 : lastRemoteVolume || 1 });
  },
  toggleShuffle: () => (remoteNow() ? void remoteCommand({ cmd: "shuffle" }) : usePlayer.getState().toggleShuffle()),
  cycleRepeat: () => (remoteNow() ? void remoteCommand({ cmd: "repeat" }) : usePlayer.getState().cycleRepeat()),
};

/** The remote control sheet (song, seek, transport, volume, the other device's queue). */
export const useRemoteSheet = create<{ open: boolean }>(() => ({ open: false }));
export const openRemoteSheet = (open = true) => useRemoteSheet.setState({ open });
