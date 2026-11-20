# AGENTS.md

Guide for coding agents and contributors working on RiiMusic. User-facing docs live in `README.md` (Vietnamese); this file is the engineering reference.

## What it is

A self-hosted music web app for a small group. Songs come from YouTube / YouTube Music through yt-dlp. One Go binary serves the API and the embedded React app (PWA). All state lives in `DATA_DIR`: SQLite, audio files, covers, the yt-dlp binary, `secret.key`, `cookies.txt`.

## Commands

```bash
# web (from web/)
pnpm install
pnpm build            # tsc --noEmit + vite build → web/dist (embedded by Go)
pnpm typecheck
pnpm dev              # Vite dev server, proxies /api to :8080

# server (repo root)
go build -o rii_music .        # Windows: rii_music.exe
go vet ./... && go test ./...
./rii_music                    # reads .env (ENV_FILE), serves :8080

# Docker
docker compose up -d --build   # AGENT_BINARIES=true also ships exe agents (+60 MB)
```

Build order matters: `web/dist` is embedded at Go build time, so run `pnpm build` before `go build`. Alternatively set `WEB_DIR=./web/dist` to serve the UI from disk during development.

Before finishing a change: `go vet ./...`, `go test ./...`, `pnpm typecheck`, and keep `vi`/`en` locale keys in sync (see i18n).

## Layout

```
main.go                     startup, .env loading, log ring buffer, DB rename (vang.db → rii_music.db), `discord-agent` subcommand
internal/db                 SQLite (modernc, single connection) + migrations via PRAGMA user_version
internal/ytdlp              manages the yt-dlp binary (nightly, SHA-256 checked, daily refresh), runs it as a child process
internal/textutil           accent folding, YouTube title cleanup, language detection (DetectLang)
internal/discordrpc         Discord IPC client + polling agent (exe fallback for the script agents)
internal/server/            HTTP API (net/http 1.22 routing), one file per area:
  server.go                   routes, middleware, CORS, static/SPA serving
  auth.go tokens.go mail.go   accounts, sessions, OTP, API/agent tokens, SMTP
  admin.go logbuf.go          admin endpoints, in-memory log buffer (secrets masked)
  library.go playlists.go     tracks, artists, albums, playlists (per user)
  downloader.go               job queue, yt-dlp download, ffmpeg remux/tag/cover, ingest
  ytmusic.go collections.go   YouTube Music InnerTube search / next / browse, album & playlist views
  lyrics.go                   LRCLIB lookup, per-user choices, community picks
  recs.go external.go         taste profile, tier-1 similar artists (Deezer / Last.fm)
  features.go mood.go         ffmpeg audio features, sound-alikes, mood playlists
  stats.go autoplay.go autodl.go  home, radio, history stats, autoplay suggestions, auto-download + eviction
  lang.go                     song language resolution, onboarding suggestions
  share.go branding.go        signed share links + 30 s previews, site name/logo/SEO injection
  presence.go agentscripts.go Discord now-playing state, /agent.ps1 and /agent.sh
  settings.go docs.go hub.go  user/server settings, OpenAPI table, per-user SSE hub
  agent/                      PowerShell and sh+python agent templates (go:embed)
web/src/
  player/                   Zustand queue store, audio engine (two <audio> + Web Audio: crossfade, gapless, gain, analyser), autofill
  pages/ components/ lib/   UI (TanStack Router + Query, Tailwind v4, Radix, dnd-kit)
  i18n/locales/{vi,en}/     JSON dictionaries per area
```

## Architecture notes

**Multi-user data model.** `tracks` (files, covers, lyrics, audio features, language) are shared server-wide; `user_tracks` links a user to a track. Likes, playlists, listens, jobs, lyrics choices, feedback and settings are per user. Removing a song removes the user's link; the file is garbage-collected when no user owns it. Downloading a song already on the server just links it. Anything computed server-wide (sound-alikes from `track_features`, co-listening) must be filtered to the user's library before use (`rc.byID` lookups must check `ok`).

**Migrations.** `internal/db/db.go`, numbered by `PRAGMA user_version`. Never edit a shipped migration; append a new one. A legacy single-user database is refused (`ErrLegacyDB`).

**Auth.** PBKDF2-SHA256 (600k iterations). Session cookie `rii_session` is HMAC-signed `uid.ver.exp.sig`; bumping `session_version` revokes every session. Cookie-authenticated mutating requests must carry the `X-RiiMusic` header (CSRF guard). Bearer tokens (`rii_…`, kind `api` or `agent`) skip it; agent tokens only reach `/api/agent/nowplaying`. OTP codes are hashed, expire in 10 min, allow 5 tries, 60 s resend cooldown.

**Song metadata.** Titles and artists come from YouTube Music `next` for the video id (ATV / OMV types are trusted). Title heuristics apply only to user uploads. Do not "guess" names when the API has them.

**Language.** `textutil.DetectLang` uses script (ko/ja/zh/th), Vietnamese letters, and a word list for unaccented Vietnamese. `resolveLangs` lets an artist's majority override weak guesses (`en`, `zh`, empty), so V-pop with English titles stays `vi`; lyrics refine it. Radio, mixes, autoplay and auto-download stay in one language (`sameLang`). lingua-go was rejected (+110 MB binary, and it doesn't solve V-pop with English titles).

**Recommendations.** Taste profile from listens (finish +1, repeat +2, skip before 30 s −1.5), likes, playlists and "less like this", decaying with a 30-day half-life. Tier 1: similar artists from Deezer (no key) or Last.fm, cached 7 days. Tier 2: co-listening within sessions. Tier 3: hand-crafted ffmpeg features over 90 s (spectrum, energy, tempo), z-scored per dimension; not a learned embedding.

**Autoplay** (`web/src/player/autofill.ts` + `/api/radio`, `/api/recs/autoplay`). Modes: off / lib / free. When fewer than 5 upcoming tracks remain it tops the queue up to 10 from radio; free mode also downloads up to 6 new songs and slots them in when ready. Skipped entries do not come back. Home shelves pass `oneLang` so a mixed shelf only queues songs in the picked song's language.

**Auto-download.** Opt-in per user; every 6 h pre-downloads up to 8 songs within the user's storage limit. Over the limit, it evicts the least likely to be played, never liked, playlisted, added in the last 3 days, or played in the last 14 days. Removed songs are not fetched again for 90 days.

**Lyrics.** Shared LRCLIB result per track plus per-user choices; resolution order is mine > community (≥ 2 users picked the same LRCLIB id) > automatic.

**Share links.** `/s/<trackId>-<hmac>`. Signed-out visitors get a 30 s preview (stream-copied by ffmpeg from about 25 % in, cached in `data/previews`). Share pages are `noindex`; only the site root is indexable.

**Branding.** Name, description and logo are stored in settings and injected into `index.html` and the manifest, and exposed as `window.__RII_BRAND__`.

**Discord presence.** Discord only accepts presence through local IPC on the user's machine. The browser posts now-playing to the server (`/api/nowplaying`, 60 s heartbeat) when the user enabled it; an agent on the desktop polls `/api/agent/nowplaying` and talks to the Discord pipe/socket. Agents: `/agent.ps1` (PowerShell 5.1+, nothing to install) and `/agent.sh` (sh + python3), generated with the server URL; the token is prompted for and stored locally, never put in a URL. The Go binary's `discord-agent` subcommand is the exe fallback. The fallback art asset key is `riimusic`.

**API docs.** The `apiDocs` table in `docs.go` generates OpenAPI 3.1 at `/api/openapi.json`; `/docs` renders it. `TestDocsMatchRoutes` fails if a documented endpoint is not routed, so add a row when you add an endpoint. The TypeScript client is `internal/server/client.ts`.

**Realtime.** Per-user SSE hub (`/api/events`): job progress, library changes, loudness results. Proxies must not buffer it.

## Frontend conventions

- i18n: never hard-code UI text. Use `t()` / `tn()` (plurals) from `@/i18n`; add keys to both `web/src/i18n/locales/vi/<area>.json` and `en/<area>.json`. Server errors are Vietnamese strings translated client-side via `en/errors.json` (`_prefixes` for dynamic messages).
- Notifications: `notify()` / `toast()`; explanations go in `Tip` / `Hint` rather than long paragraphs.
- Accent colours are CSS variables (`--vg-accent`, `--np-accent`); `lib/theme.ts` sets `--ah/--as/--al` for the 12 accents or the cover colour.
- Now Playing surfaces are always dark (`[data-now-playing]`).
- Artist names render through `ArtistLinks` (one link per credited artist; the split regex mirrors the server's `artistSplitRe`).
- Browser storage keys are prefixed `rii-`.
- Windows: `vite.config.ts` pins `root` and the `@` alias to one absolute path. Drive-letter case mismatches otherwise load modules twice (two player stores).

## Working rules

- Never read, print or commit `.env` (it holds the admin password and the Gmail app password). `.env`, `data/`, `*.exe`, `*.exe~` and `.prepare/` are not committed.
- Test anything destructive (eviction, reset, cleanup) against a copy of `data/` on another port, e.g. `DATA_DIR=/tmp/copy PORT=8081 ENV_FILE=/nonexistent ./rii_music`. Copy `rii_music.db-wal` with the database or recent writes are missing.
- The live server may be in use while you work: when cleaning up test data there, delete only the exact ids you created.
- Files use LF line endings (`.gitattributes`). On Windows, write files in binary/`newline=""` mode when scripting, and run Python with `PYTHONUTF8=1`.
- Commit in small steps with clear messages. Keep someone else's uncommitted edits out of your commits unless asked.
- Renames: data and protocol names (`rii_music.db`, `X-RiiMusic`, `rii_` tokens, `RIIMUSIC_*` env vars, `rii-*` storage keys) are part of the contract with existing installs and clients; changing them logs everyone out and breaks tokens.

## Extra environment variables

Beyond the ones in `README.md`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_DIR` | | Serve the UI from this directory instead of the embedded build |
| `YTDLP_JS_RUNTIME` | deno, then node | JS runtime yt-dlp uses for YouTube |
| `YTDLP_REMOTE_EJS` | `true` | Pass `--remote-components ejs:github` |
| `AGENT_DIR` | `/opt/rii_music/agent` in Docker | Prebuilt exe agents (only with `AGENT_BINARIES=true`) |
| `TZ` | `Asia/Ho_Chi_Minh` in Docker | Log time zone |

## Not done yet

Offline cache, equalizer, cross-device playback sync, learned audio embeddings (e.g. CLAP) for tier 3, a desktop wrapper (Tauri) that could consume the `riimusic:nowplaying` window event.
