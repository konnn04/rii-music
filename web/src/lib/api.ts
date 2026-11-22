import { translateServer } from "@/i18n";
// Typed client for the RiiMusic API. Mutating requests carry the X-RiiMusic header the server requires.

export type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  hasCover: boolean;
  gainDb: number;
  playCount: number;
  lastPlayedAt: number;
  addedAt: number;
  mime: string;
  liked: boolean;
  sourceUrl: string;
  lang?: string;
  genres?: string[];
};

export type Artist = { name: string; trackCount: number; albumCount: number; coverTrackId: string; playCount: number };
export type Album = { name: string; artist: string; trackCount: number; coverTrackId: string; addedAt: number; durationMs: number };
export type Genre = { name: string; count: number };
export type Rule = { type: "top30" | "recent" | "unplayed" | "artist" | "genre"; value?: string; limit?: number };
export type Playlist = {
  id: string;
  name: string;
  kind: "manual" | "smart" | "system";
  rule?: Rule;
  trackCount: number;
  durationMs: number;
  coverTrackIds: string[];
  updatedAt: number;
};
export type Job = {
  id: string;
  url: string;
  sourceId: string;
  title: string;
  status: "queued" | "downloading" | "processing" | "done" | "error" | "skipped";
  progress: number;
  stage: string;
  error: string;
  trackId: string;
  userId?: string;
  /** user: added by hand; autoplay: queue suggestion; auto: Tự động tải nhạc */
  origin: "user" | "autoplay" | "auto";
  createdAt: number;
  updatedAt: number;
};
export type WebKind = "songs" | "videos" | "albums" | "playlists";
export type WebResult = {
  id: string;
  title: string;
  channel: string;
  artist?: string;
  album?: string;
  duration: number;
  thumbnail: string;
  url: string;
  inLibrary: string;
  /** Someone on this server already has it: adding is instant. */
  onServer?: boolean;
  kind: WebKind | "youtube";
};
export type Lyrics = {
  plain: string;
  synced: string;
  source: "lrclib" | "manual" | "none";
  offsetMs: number;
  lrclibId?: number;
  /** auto: found by RiiMusic; mine: picked / pasted by you; community: picked by several users */
  choice: "auto" | "mine" | "community";
};
export type Settings = {
  /** The admin's limits (read-only). */
  limits?: { autoplayTarget: number; autoplayDownloads: number };
  crossfadeSec: number;
  gaplessAlbum: boolean;
  normalize: boolean;
  theme: "dark" | "light" | "system";
  accent: string;
  visualizer: boolean;
  autoDownload: boolean;
  autoplayMode: "off" | "lib" | "free";
  onboarded: boolean;
  prefLangs: string[];
  prefGenres: string[];
  prefArtists: string[];
  discordPresence: boolean;
  language: "vi" | "en";
};
export type ServerSettings = {
  audioFormat: "m4a" | "opus";
  bitrate: number;
  discordAppId: string;
  agentUrl: string;
  autoplayTarget: number;
  autoplayDownloads: number;
  autoDlPerRun: number;
  playlistMax: number;
};
export type Branding = { name: string; description: string; logoUrl: string; customLogo: boolean };
export type APIToken = { id: string; kind: "api" | "agent"; name: string; prefix: string; createdAt: number; lastUsedAt: number };
export type WebList = { id: string; title: string; subtitle: string; thumbnail: string; tracks: WebResult[]; saved?: string };
export type Role = "admin" | "listener";
export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  storageLimitMb: number;
  disabled: boolean;
  hasPassword: boolean;
  createdAt: number;
  lastLoginAt: number;
};
export type Me = { user: User; usedBytes: number; tracks: number; limitBytes: number; mailConfigured: boolean };
export type AdminUser = User & {
  usedBytes: number;
  tracks: number;
  plays30d: number;
  lastListenAt: number;
  online: boolean;
  autoDownload: boolean;
  activeJobs: number;
  note?: string;
};
export type AutoDLStatus = {
  enabled: boolean;
  limitBytes: number;
  usedBytes: number;
  tracks: number;
  autoTracks: number;
  pending: number;
  running: boolean;
  lastRun: number;
  nextRun: number;
  lastAdded: number;
  lastEvicted: number;
  lastMessage: string;
};
export type Mix = { id: string; name: string; reason: string; tracks: Track[] };
export type RecTrack = Track & { reason: string };
export type DiscoverArtist = { name: string; image: string; reason: string; inLibrary: boolean };
export type DiscoverTrack = { title: string; artist: string; durationSec: number; image: string; reason: string; query: string };
export type SimilarArtist = { name: string; image: string; libraryName: string; coverTrackId: string; trackCount: number };
export type Home = {
  continue: Track[];
  recentlyAdded: Track[];
  topArtists: Artist[];
  mixes: Mix[];
  timeOfDay: { label: string; tracks: Track[] };
  libraryCount: number;
  forYou: RecTrack[];
  similarArtists: { seed: string; artists: { name: string; image: string; inLibrary: boolean }[] } | null;
};
export type Stats = {
  days: { date: string; minutes: number }[];
  totalMinutes: number;
  plays: number;
  skips: number;
  topTracks: (Track & { plays: number })[];
  topArtists: { name: string; plays: number; coverTrackId: string }[];
  hours: number[];
  libraryCount: number;
};
export type HistoryItem = { track: Track; startedAt: number; playedMs: number; action: "finish" | "skip" | "repeat" };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-RiiMusic", "1");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body, credentials: "same-origin" });
  if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized();
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, translateServer(msg) || `Error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const coverUrl = (id: string) => `/api/tracks/${id}/cover`;
export const streamUrl = (id: string) => `/api/tracks/${id}/stream`;
