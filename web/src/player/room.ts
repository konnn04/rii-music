// Nghe chung (listen together). A room has a 6-character code; everyone in it
// plays the same queue in sync. The host and "controller" members change what
// plays (their player's changes are sent to the room); "listener" members
// follow. Server: internal/server/rooms.go; events arrive as SSE "room".
//
//  - Sync: a room state is { queue, index, positionMs, playing, updatedAt };
//    members load the queue, seek to positionMs + time since updatedAt
//    (server clock, corrected with the "now" sent along) and play or pause.
//  - Drift: every 10 s a member more than 2.5 s off seeks back in line.
//  - Connection: heartbeat every 20 s. A failed heartbeat shows
//    "reconnecting"; when it works again the room is reloaded. 404 = closed.
//    After a page reload, /api/rooms/mine puts you back in your room.

import { create } from "zustand";
import { api, ApiError, type Track } from "@/lib/api";
import { queryClient } from "@/lib/queries";
import { useKaraoke } from "@/karaoke/store";
import { isDesktop, notifyDesktop } from "@/lib/desktop";
import { toast } from "@/components/ui/Toast";
import { t } from "@/i18n";
import { usePlayback, usePlayer } from "./store";
import { engine } from "./engine";
import { setRoomRole } from "./roomFlag";

export type RoomRole = "host" | "controller" | "listener";
export type RoomMember = { userId: string; name: string; role: RoomRole; connected: boolean; joinedAt: number };
export type RoomStateData = { queue: string[]; index: number; positionMs: number; playing: boolean; updatedAt: number; rev: number; by: string };
export type RoomView = { code: string; hostId: string; createdAt: number; state: RoomStateData; members: RoomMember[] };
export type RoomEvent = { type: "state" | "members" | "closed"; room?: RoomView; tracks?: Track[]; now?: number; code?: string; reason?: string };

type RoomStore = {
  room: RoomView | null;
  tracks: Track[];
  status: "idle" | "connected" | "reconnecting";
  /** Server time minus local time (ms). */
  skew: number;
};

export const useRoom = create<RoomStore>(() => ({ room: null, tracks: [], status: "idle", skew: 0 }));

const myId = () => queryClient.getQueryData<{ user: { id: string } }>(["me"])?.user.id ?? "";

/** My role in the room I'm in ("" when not in one). */
export function useMyRole(): RoomRole | "" {
  return useRoom((s) => s.room?.members.find((m) => m.userId === myId())?.role ?? "");
}
const myRole = (): RoomRole | "" => useRoom.getState().room?.members.find((m) => m.userId === myId())?.role ?? "";
export const canControl = () => {
  const r = myRole();
  return r === "host" || r === "controller";
};

// ── applying the room's state to this player ─────────────────────────────

let applying = 0; // > now: local player changes come from the room, don't send them back
let lastApplied = 0; // rev
const sourceFor = (code: string) => ({ type: "queue" as const, id: `room:${code}`, name: t("room.source", { code }) });

function expectedPositionMs(st: RoomStateData): number {
  if (!st.playing) return st.positionMs;
  const serverNow = Date.now() + useRoom.getState().skew;
  return st.positionMs + Math.max(0, serverNow - st.updatedAt);
}

function applyState(force = false) {
  const { room, tracks } = useRoom.getState();
  if (!room) return;
  const st = room.state;
  if (!force && st.rev <= lastApplied) return;
  lastApplied = st.rev;
  const byId = new Map(tracks.map((tr) => [tr.id, tr]));
  const list = st.queue.map((id) => byId.get(id)).filter((x): x is Track => !!x);
  const want = st.queue[st.index];
  if (!want || !list.length) return;
  applying = Date.now() + 1500;
  const p = usePlayer.getState();
  const local = [p.current?.track.id, ...p.manual.map((e) => e.track.id), ...p.context.slice(p.pos + 1).map((e) => e.track.id)];
  const sameQueue = local.join(",") === st.queue.slice(st.index).join(",");
  if (p.current?.track.id !== want || !sameQueue) {
    const start = list.findIndex((tr) => tr.id === want);
    usePlayer.getState().playList(list, Math.max(0, start), sourceFor(room.code), { shuffle: false, local: true });
  }
  const seekWhenReady = () => {
    const target = expectedPositionMs(st) / 1000;
    const pb = usePlayback.getState();
    if (Math.abs(pb.position - target) > 1.5) void engine.seek(Math.min(target, Math.max(0, pb.duration - 1)));
    if (st.playing && !pb.isPlaying) void engine.play();
    if (!st.playing && pb.isPlaying) void engine.pause();
  };
  if (usePlayback.getState().duration > 0 && usePlayer.getState().current?.track.id === want) seekWhenReady();
  else {
    const unsub = usePlayback.subscribe((pb) => {
      if (pb.duration > 0 && usePlayer.getState().current?.track.id === want) {
        unsub();
        seekWhenReady();
      }
    });
    window.setTimeout(unsub, 15_000);
  }
}

function setRoom(room: RoomView | null, tracks?: Track[], now?: number) {
  if (now) useRoom.setState({ skew: now - Date.now() });
  useRoom.setState((s) => ({ room, tracks: tracks ?? s.tracks, status: room ? "connected" : "idle" }));
  setRoomRole(myRole());
  // In a room karaoke is off (see karaoke/store.ts).
  if (myRole() && (useKaraoke.getState().mode !== "off" || useKaraoke.getState().open)) useKaraoke.setState({ mode: "off", open: false });
}

/** Fed from the SSE "room" event. */
export function onRoomEvent(ev: RoomEvent) {
  const cur = useRoom.getState().room;
  if (ev.type === "closed") {
    if (cur && (!ev.code || ev.code === cur.code)) {
      reset();
      toast(ev.reason === "idle" ? t("room.closedIdle") : t("room.closed"));
    }
    return;
  }
  if (!ev.room || (cur && ev.room.code !== cur.code)) return;
  if (ev.type === "members" && cur && isDesktop() && document.hidden) {
    const prevIds = new Set(cur.members.map((m) => m.userId));
    const me = myId();
    for (const m of ev.room.members) {
      if (!prevIds.has(m.userId) && m.userId !== me) {
        void notifyDesktop(t("room.title"), t("room.notify.joined", { name: m.name }));
      }
    }
  }
  const wasRole = myRole();
  setRoom(ev.room, ev.tracks, ev.now);
  const role = myRole();
  if (wasRole && role && wasRole !== role) toast(role === "controller" ? t("room.nowController") : t("room.nowListener"));
  if (ev.type === "state" && ev.room.state.by !== myId()) applyState();
}

// ── sending this player's changes (host / controllers) ──────────────────

let sendTimer: number | null = null;

function localState() {
  const p = usePlayer.getState();
  const pb = usePlayback.getState();
  const ids = [p.current?.track.id, ...p.manual.map((e) => e.track.id), ...p.context.slice(p.pos + 1).map((e) => e.track.id)].filter(
    (x): x is string => !!x,
  );
  return { queue: ids.slice(0, 200), index: 0, positionMs: Math.round((pb.position || 0) * 1000), playing: pb.isPlaying };
}

function scheduleSend() {
  const room = useRoom.getState().room;
  if (!room || Date.now() < applying) return;
  if (!canControl()) {
    // Listeners follow the room: undo a local change after a moment.
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = window.setTimeout(() => {
      if (Date.now() < applying) return;
      toast(t("room.listenOnly"));
      applyState(true);
    }, 400);
    return;
  }
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = window.setTimeout(async () => {
    const r = useRoom.getState().room;
    if (!r || !usePlayer.getState().current) return;
    try {
      const res = await api<{ rev: number }>(`/api/rooms/${r.code}/state`, { method: "POST", json: localState() });
      lastApplied = Math.max(lastApplied, res.rev);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) gone();
    }
  }, 300);
}

let subscribed = false;
function subscribeLocal() {
  if (subscribed) return;
  subscribed = true;
  usePlayer.subscribe((s, prev) => {
    if (!useRoom.getState().room) return;
    if (s.current?.uid !== prev.current?.uid || s.manual !== prev.manual || s.context !== prev.context) scheduleSend();
  });
  usePlayback.subscribe((s, prev) => {
    if (!useRoom.getState().room) return;
    if (s.isPlaying !== prev.isPlaying || (s.isPlaying && Math.abs(s.position - prev.position) > 3)) scheduleSend();
  });
}

// ── connection ──────────────────────────────────────────────────────────

let heartbeat: number | null = null;
let drift: number | null = null;

function startLoops() {
  subscribeLocal();
  if (!heartbeat)
    heartbeat = window.setInterval(async () => {
      const r = useRoom.getState().room;
      if (!r) return;
      try {
        const res = await api<{ rev: number; now: number }>(`/api/rooms/${r.code}/heartbeat`, { method: "POST" });
        useRoom.setState({ skew: res.now - Date.now() });
        if (useRoom.getState().status === "reconnecting" || res.rev > (useRoom.getState().room?.state.rev ?? 0)) await reload();
        else useRoom.setState({ status: "connected" });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) gone();
        else useRoom.setState({ status: "reconnecting" });
      }
    }, 20_000);
  if (!drift)
    drift = window.setInterval(() => {
      const r = useRoom.getState().room;
      if (!r || !r.state.playing || Date.now() < applying) return;
      if (canControl() && r.state.by === myId()) return; // my own state: I am the reference
      const pb = usePlayback.getState();
      if (!pb.isPlaying || usePlayer.getState().current?.track.id !== r.state.queue[r.state.index]) return;
      const target = expectedPositionMs(r.state) / 1000;
      if (Math.abs(pb.position - target) > 2.5) {
        applying = Date.now() + 1500;
        void engine.seek(target);
      }
    }, 10_000);
}

function stopLoops() {
  if (heartbeat) clearInterval(heartbeat);
  if (drift) clearInterval(drift);
  heartbeat = drift = null;
}

function reset() {
  stopLoops();
  lastApplied = 0;
  setRoom(null, []);
}

function gone() {
  if (!useRoom.getState().room) return;
  reset();
  toast(t("room.closed"));
}

async function reload() {
  const r = useRoom.getState().room;
  if (!r) return;
  const res = await api<{ room: RoomView; tracks: Track[]; now: number }>(`/api/rooms/${r.code}`);
  setRoom(res.room, res.tracks, res.now);
  applyState(true);
}

// ── actions for the UI ─────────────────────────────────────────────────

/** "Phát trạm": open a room with what this device plays now. */
/** Starting or joining a room while karaoke is on is refused (and the other way round). */
function refuseIfKaraoke() {
  if (useKaraoke.getState().mode !== "off") throw new Error(t("room.karaokeOn"));
}

export async function createRoom() {
  refuseIfKaraoke();
  const res = await api<{ room: RoomView; tracks: Track[]; now: number }>("/api/rooms", { method: "POST", json: localState() });
  lastApplied = res.room.state.rev;
  setRoom(res.room, res.tracks, res.now);
  startLoops();
  return res.room.code;
}

export async function joinRoom(code: string) {
  refuseIfKaraoke();
  const c = code.trim().toUpperCase();
  const res = await api<{ room: RoomView; tracks: Track[]; now: number }>(`/api/rooms/${encodeURIComponent(c)}/join`, { method: "POST" });
  setRoom(res.room, res.tracks, res.now);
  startLoops();
  applyState(true);
}

export async function leaveRoom() {
  const r = useRoom.getState().room;
  if (!r) return;
  reset();
  await api(`/api/rooms/${r.code}/leave`, { method: "POST" }).catch(() => {});
}

/** Host only: close the room for everyone. */
export async function closeRoom() {
  const r = useRoom.getState().room;
  if (!r) return;
  reset();
  await api(`/api/rooms/${r.code}`, { method: "DELETE" }).catch(() => {});
}

/** Host only. */
export async function setMemberRole(userId: string, role: "controller" | "listener") {
  const r = useRoom.getState().room;
  if (!r) return;
  await api(`/api/rooms/${r.code}/role`, { method: "POST", json: { userId, role } });
}

/** Re-sync this player with the room now ("Đồng bộ lại"). */
export function resyncRoom() {
  void reload();
}

/** After a page load: back into the room this account is in, if any. */
export async function initRoom() {
  try {
    const res = await api<{ room: RoomView | null; tracks?: Track[]; now?: number }>("/api/rooms/mine");
    if (!res.room) return;
    setRoom(res.room, res.tracks, res.now);
    startLoops();
    applyState(true);
  } catch {
    /* offline: nothing to rejoin */
  }
}
