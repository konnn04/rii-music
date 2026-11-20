/**
 * RiiMusic API client: one file, no dependencies, works in Node 18+, Deno, Bun and browsers.
 *
 *   import { RiiMusic } from "./riimusic-client";
 *   const music = new RiiMusic("https://nhac.example.com", process.env.VANG_TOKEN!);
 *   const me = await music.me();
 *   const hits = await music.search("tìm em");
 *   await music.download(hits.results[0].url);
 *
 * Create a token in RiiMusic → Cài đặt → API. Everything you do with it acts as
 * your own account (your library, playlists, history).
 */

export type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  hasCover: boolean;
  playCount: number;
  lastPlayedAt: number;
  addedAt: number;
  liked: boolean;
  lang: string;
};
export type Playlist = { id: string; name: string; kind: "manual" | "smart" | "system"; trackCount: number; durationMs: number };
export type Job = { id: string; url: string; title: string; status: "queued" | "downloading" | "processing" | "done" | "error" | "skipped"; progress: number; stage: string; error: string; trackId: string };
export type WebResult = { id: string; title: string; artist?: string; album?: string; duration: number; url: string; inLibrary: string; onServer?: boolean; kind: string };
export type Lyrics = { plain: string; synced: string; source: string; offsetMs: number; choice: "auto" | "mine" | "community" };
export type Mood = "happy" | "sad" | "chill" | "energetic" | "focus";

export class VangError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class RiiMusic {
  constructor(
    private base: string,
    private token: string,
  ) {
    this.base = base.replace(/\/+$/, "");
  }

  /** Low-level call: any endpoint from /docs. */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* not json */
      }
      throw new VangError(res.status, msg);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
  }

  // account
  me() {
    return this.request<{ user: { id: string; email: string; name: string; role: string }; usedBytes: number; limitBytes: number; tracks: number }>("GET", "/api/me");
  }

  // library
  tracks(sort: "added" | "title" | "artist" | "plays" = "added") {
    return this.request<Track[]>("GET", `/api/tracks?sort=${sort}`);
  }
  track(id: string) {
    return this.request<Track>("GET", `/api/tracks/${id}`);
  }
  /** Direct URL of the audio file (send the token as a header to fetch it). */
  streamUrl(id: string) {
    return `${this.base}/api/tracks/${id}/stream`;
  }
  like(id: string, liked = true) {
    return this.request(liked ? "PUT" : "DELETE", `/api/likes/${id}`);
  }
  removeTrack(id: string) {
    return this.request("DELETE", `/api/tracks/${id}`);
  }
  lyrics(id: string) {
    return this.request<Lyrics>("GET", `/api/tracks/${id}/lyrics`);
  }

  // search & download
  search(q: string, kind: "songs" | "albums" | "playlists" | "videos" = "songs") {
    return this.request<{ results: WebResult[]; source: string }>("GET", `/api/search?scope=web&kind=${kind}&q=${encodeURIComponent(q)}`);
  }
  /** Links (YouTube, YouTube Music, playlists) or search words, one per line. */
  download(input: string | string[]) {
    return this.request<{ jobs: Job[]; errors: string[] }>("POST", "/api/downloads", { input: Array.isArray(input) ? input.join("\n") : input });
  }
  jobs() {
    return this.request<{ jobs: Job[] }>("GET", "/api/downloads");
  }
  /** Resolves when the job finishes (polls every 2 s). */
  async waitForJob(id: string, timeoutMs = 10 * 60_000): Promise<Job> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const j = (await this.jobs()).jobs.find((x) => x.id === id);
      if (!j) throw new VangError(404, "job not found");
      if (j.status === "done" || j.status === "error" || j.status === "skipped") return j;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new VangError(408, "timeout");
  }

  // playlists
  playlists() {
    return this.request<Playlist[]>("GET", "/api/playlists");
  }
  playlist(id: string) {
    return this.request<{ playlist: Playlist; tracks: Track[] }>("GET", `/api/playlists/${id}`);
  }
  createPlaylist(name: string, trackIds: string[] = []) {
    return this.request<Playlist>("POST", "/api/playlists", { name, trackIds });
  }
  addToPlaylist(id: string, trackIds: string[]) {
    return this.request("POST", `/api/playlists/${id}/items`, { trackIds });
  }

  // listening & recommendations
  logListen(trackId: string, playedMs: number, action: "finish" | "skip" | "repeat" = "finish") {
    return this.request("POST", "/api/events/listen", { trackId, playedMs, action });
  }
  history(limit = 100) {
    return this.request<{ track: Track; startedAt: number; playedMs: number; action: string }[]>("GET", `/api/history?limit=${limit}`);
  }
  stats(days = 30) {
    return this.request<{ totalMinutes: number; plays: number; topTracks: (Track & { plays: number })[]; topArtists: { name: string; plays: number }[] }>(
      "GET",
      `/api/stats?days=${days}&tz=${new Date().getTimezoneOffset()}`,
    );
  }
  radio(seedTrackId: string) {
    return this.request<{ name: string; tracks: Track[] }>("GET", `/api/radio?seed=${seedTrackId}`);
  }
  mood(mood: Mood) {
    return this.request<{ name: string; reason: string; tracks: Track[] }>("POST", "/api/recs/mood", { mood });
  }
  shareLink(trackId: string) {
    return this.request<{ url: string }>("GET", `/api/tracks/${trackId}/share`);
  }
}
