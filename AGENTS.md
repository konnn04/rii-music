# AGENTS.md

Guide for coding agents and contributors working on RiiMusic: commands, layout, conventions and rules. User and operator docs are in [`docs/`](docs/README.md); the internals are in [`docs/architecture.md`](docs/architecture.md).

## What it is

A self-hosted music web app for a small group. Songs come from YouTube / YouTube Music through yt-dlp. One Go binary serves the API and the embedded React app (PWA). Tables live in PostgreSQL (`DATABASE_URL`); files live in `DATA_DIR`: audio, covers, previews, the yt-dlp binary, `secret.key`, `cookies.txt`.

## Commands

```bash
# web (from web/)
pnpm install
pnpm build            # tsc --noEmit + vite build → web/dist (embedded by Go)
pnpm typecheck
pnpm dev              # Vite dev server, proxies /api to :8080

# server (repo root)
go build -o rii_music .        # Windows: rii_music.exe
go vet ./...
TEST_DATABASE_URL=postgres://rii@localhost:5432/rii_test?sslmode=disable go test ./...   # tests skip without it
./rii_music migrate status     # or: migrate up
./rii_music                    # reads .env (ENV_FILE), serves :8080

# Docker
docker compose up -d --build   # AGENT_BINARIES=true also ships exe agents (+60 MB)
```

Build order matters: `web/dist` is embedded at Go build time, so run `pnpm build` before `go build`. Alternatively set `WEB_DIR=./web/dist` to serve the UI from disk during development.

Before finishing a change: `go vet ./...`, `go test ./...`, `pnpm typecheck`, and keep `vi`/`en` locale keys in sync (see i18n).

## Layout

```
main.go                     startup, .env loading, log ring buffer, `migrate` and `discord-agent` subcommands
internal/db                 PostgreSQL via pgx (database/sql), `?` → `$n` rewriting, numbered migrations in migrations/*.sql
internal/ytdlp              manages the yt-dlp binary (nightly, SHA-256 checked, daily refresh), runs it as a child process
internal/textutil           accent folding, YouTube title cleanup, language detection (DetectLang)
internal/discordrpc         Discord IPC client + polling agent (exe fallback for the script agents)
internal/server/            HTTP API (net/http 1.22 routing), one file per area:
  server.go                   routes, middleware, CORS, static/SPA serving
  auth.go tokens.go mail.go   accounts, sessions, OTP, API/agent tokens, SMTP
  admin.go logbuf.go          admin endpoints, in-memory log buffer (secrets masked)
  library.go playlists.go     tracks, artists, albums, playlists (per user)
  follows.go                  followed artists (sidebar list, taste boost)
  downloader.go               job queue, yt-dlp download, ffmpeg remux/tag/cover, ingest
  ytmusic.go collections.go   YouTube Music InnerTube search / next / browse, album & playlist views
  lyrics.go                   LRCLIB lookup, per-user choices, community picks
  recs.go external.go         taste profile, tier-1 similar artists (Deezer / Last.fm)
  features.go mood.go         ffmpeg audio features, sound-alikes, mood playlists
  stats.go autoplay.go autodl.go  home, radio, history stats, autoplay suggestions, auto-download + eviction
  lang.go                     song language resolution, onboarding suggestions
  share.go branding.go        signed share links + 30 s previews, site name/logo/SEO injection
  presence.go agentscripts.go Discord now-playing state, /agent.ps1 and /agent.sh
  playback.go rooms.go        device sync + remote control, Nghe chung (listen-together) rooms
  settings.go docs.go hub.go  user/server settings, OpenAPI table, per-user SSE hub
  agent/                      PowerShell and sh+python agent templates (go:embed)
desktop.go                  desktop modes: RII_MODE=local (embedded PostgreSQL, vault, auto-login) / client (proxy)
internal/vault              encrypted, seekable audio files (local mode)
internal/clientproxy        desktop client mode: reverse proxy to a RiiMusic server
internal/ffmpegdl           downloads a static ffmpeg on first use (local mode)
desktop/                    Tauri v2 shell (setup screen, sidecar, tray, autostart, deep links); see desktop/README.md
web/src/
  player/                   Zustand queue store, audio engine (two <audio> + Web Audio: crossfade, gapless, gain, analyser), autofill
  pages/ components/ lib/   UI (TanStack Router + Query, Tailwind v4, Radix, dnd-kit)
  i18n/locales/{vi,en}/     JSON dictionaries per area
```

## Architecture

Read [docs/architecture.md](docs/architecture.md) before changing a subsystem: data model, database and migrations, auth, song metadata and language, recommendations, autoplay, auto-download, lyrics, share links, Discord presence, realtime, playback sync / remote control, Nghe chung rooms, sound effects, offline, enrichment, versioning. Keep it up to date when you change how something works.

Rules worth repeating here:

- Tracks are shared server-wide; anything computed server-wide must be filtered to the user's library (`rc.byID` lookups check `ok`).
- Never edit a shipped migration; add the next number.
- Add a row to the `apiDocs` table in `docs.go` for every new endpoint (`TestDocsMatchRoutes`).
- Song names come from YouTube Music `next` (with `hl=en`); don't guess them when the API has them.

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
- Test anything destructive (eviction, reset, cleanup) against a separate database and data dir on another port, e.g. `DATABASE_URL=…/rii_scratch DATA_DIR=/tmp/copy PORT=8081 ENV_FILE=/nonexistent ./rii_music`.
- The live server may be in use while you work: when cleaning up test data there, delete only the exact ids you created.
- Files use LF line endings (`.gitattributes`). On Windows, write files in binary/`newline=""` mode when scripting, and run Python with `PYTHONUTF8=1`.
- Commit in small steps with clear messages. Keep someone else's uncommitted edits out of your commits unless asked.
- Renames: data and protocol names (`X-RiiMusic`, `rii_` tokens, `RIIMUSIC_*` env vars, `rii-*` storage keys) are part of the contract with existing installs and clients; changing them logs everyone out and breaks tokens.

## Environment variables

All of them, including the development-only ones (`WEB_DIR`, `YTDLP_JS_RUNTIME`, `YTDLP_REMOTE_EJS`, `AGENT_DIR`), are in [docs/configuration.md](docs/configuration.md).

## Not done yet

Learned audio embeddings (e.g. CLAP) for tier 3 if a stronger server is available, a desktop wrapper (Tauri) that could consume the `riimusic:nowplaying` window event.
