# Architecture

How RiiMusic works inside: data model, subsystems and the decisions behind them. Read the section for the area you are about to change. Commands, layout and coding rules are in [AGENTS.md](../AGENTS.md).

## Multi-user data model

`tracks` (files, covers, lyrics, audio features, language) are shared server-wide; `user_tracks` links a user to a track. Likes, playlists, listens, jobs, lyrics choices, feedback and settings are per user. Removing a song removes the user's link; the file is garbage-collected when no user owns it. Downloading a song already on the server just links it. Anything computed server-wide (sound-alikes from `track_features`, co-listening) must be filtered to the user's library before use (`rc.byID` lookups must check `ok`).

## Database

PostgreSQL. Queries keep `?` placeholders; `db.DB` rewrites them to `$1…`, stores Go bools as 0/1 (flag columns are SMALLINT) and repairs invalid UTF-8. Times are Unix ms in BIGINT. Emails are CITEXT. Write portable SQL: `ON CONFLICT … DO NOTHING/UPDATE`, `COUNT(*) FILTER (WHERE …)`, `lower(x)` for case-insensitive sorting, `GREATEST/LEAST`, full GROUP BY lists. Detect duplicates with `db.IsUniqueViolation`.

## Migrations

`internal/db/migrations/NNNN_name.sql`, embedded, applied in order at startup, each in a transaction, recorded in `schema_migrations`, under a `pg_advisory_lock` so two processes never migrate at once. Never edit a shipped migration; add the next number. `rii_music migrate status|up` inspects or applies them. Tests create one schema per test in `TEST_DATABASE_URL` (citext is installed in `public` once).

## Auth

PBKDF2-SHA256 (600k iterations). Session cookie `rii_session` is HMAC-signed `uid.ver.exp.sig`; bumping `session_version` revokes every session. Cookie-authenticated mutating requests must carry the `X-RiiMusic` header (CSRF guard). Bearer tokens (`rii_…`, kind `api` or `agent`) skip it; agent tokens only reach `/api/agent/nowplaying`. OTP codes are hashed, expire in 10 min, allow 5 tries, 60 s resend cooldown.

## Song metadata

Titles and artists come from YouTube Music `next` for the video id (ATV / OMV types are trusted). Title heuristics apply only to user uploads. Do not "guess" names when the API has them.

## Language

YouTube Music metadata (`next`, `browse`) is requested with `hl=en`: with `hl=vi` it rewrites "(feat. X)" as "(cùng với X)", which made English songs look Vietnamese; `unlocalizeTitle` also undoes it in search results (search keeps `hl=vi`). `textutil.DetectLang` ignores "(feat./with/cùng với …)" parts and uses script (ko/ja/zh/th), Vietnamese letters, and a word list for unaccented Vietnamese. `textutil.DetectLyricsLang` judges lyrics by proportions and recognises romanised Japanese (romaji particles); `refineLang` lets lyrics settle the language (English lyrics override a "vi" guess only when the title itself has nothing Vietnamese). `resolveLangs` lets an artist's majority override weak guesses (`en`, `zh`, empty), so V-pop with English titles stays `vi`; lyrics refine it. Radio, mixes, autoplay and auto-download stay in one language (`sameLang`). lingua-go was rejected (+110 MB binary, and it doesn't solve V-pop with English titles).

## Recommendations

Taste profile from listens (finish +1, repeat +2, skip before 30 s −1.5), likes, playlists, followed artists and dislikes, decaying with a 30-day half-life. Dislikes ("Không thích bài này / nghệ sĩ này", `feedback` value −1, listed by `GET /api/feedback`, managed in Cài đặt) are never suggested (radio, mixes, moods, autoplay, auto-download) but can still be played by hand. Songs played to the end in the last 3 hours are left out of generated lists (`taste.dropRecent`) unless the list would be too short. Tier 1: similar artists from Deezer (no key) or Last.fm, cached 7 days. Tier 2: co-listening within sessions. Tier 3: hand-crafted features, 58 dims: ffmpeg spectral stats over 90 s, energy and tempo (0–19, read by index in mood.go), MFCC 1–13 mean/std (20–45) and a key-independent chroma profile (46–57) computed in Go (`timbre.go`); z-scored per dimension, weighted per group (`featureWeight`), cosine similarity. Bump `featureVersion` when the vector changes (the worker recomputes). Not a learned embedding: the target server is small.

## Autoplay

Files: `web/src/player/autofill.ts` + `/api/radio`, `/api/recs/autoplay`.

Modes: off / lib / free. When fewer than 5 upcoming tracks remain it tops the queue up to 10 from radio; free mode also downloads up to 6 new songs and slots them in when ready. Skipped entries do not come back, and nothing already in the queue (played or upcoming) is suggested again. Listeners in a Nghe chung room get no autoplay. Home shelves pass `oneLang` so a mixed shelf only queues songs in the picked song's language.

## Auto-download

Opt-in per user; every 6 h pre-downloads up to 8 songs within the user's storage limit. Over the limit, it evicts the least likely to be played, never liked, playlisted, added in the last 3 days, or played in the last 14 days. Removed songs are not fetched again for 90 days.

## Followed artists

Files: `follows.go`, migration 0003.

`artist_follows` is keyed by `followKey` (the loose name; names in other scripts fall back to the lower-cased name), mirrored in `web/src/lib/follows.ts`. The list counts the user's library songs per artist (featured credits too). Each follow adds `followWeight` to the artist in the taste profile. The `follows` SSE event refreshes other tabs.

## Lyrics

Shared LRCLIB result per track plus per-user choices; resolution order is mine > community (≥ 2 users picked the same LRCLIB id) > automatic.

## Share links

`/s/<trackId>-<hmac>`. Signed-out visitors get a 30 s preview (stream-copied by ffmpeg from about 25 % in, cached in `data/previews`). Share pages are `noindex`; only the site root is indexable.

## Branding

Name, description and logo are stored in settings and injected into `index.html` and the manifest, and exposed as `window.__RII_BRAND__`.

## Discord presence

Discord only accepts presence through local IPC on the user's machine. The browser posts now-playing to the server (`/api/nowplaying`, 60 s heartbeat) when the user enabled it; an agent on the desktop polls `/api/agent/nowplaying` and talks to the Discord pipe/socket. Agents: `/agent.ps1` (PowerShell 5.1+, nothing to install) and `/agent.sh` (sh + python3), generated with the server URL; the token is prompted for and stored locally, never put in a URL. The Go binary's `discord-agent` subcommand is the exe fallback. The fallback art asset key is `riimusic`.

## API docs

The `apiDocs` table in `docs.go` generates OpenAPI 3.1 at `/api/openapi.json`; `/docs` renders it. `TestDocsMatchRoutes` fails if a documented endpoint is not routed, so add a row when you add an endpoint. The TypeScript client is `internal/server/client.ts`.

## Realtime

Per-user SSE hub (`/api/events`): job progress, library changes, loudness results, playback of the user's other devices. Proxies must not buffer it.

## Playback sync and remote control

Files: `web/src/player/sync.ts`, `playback.go`.

One player at a time: tabs tell each other over BroadcastChannel; devices POST `/api/playback` (on change incl. volume / shuffle / repeat / queue, + 30 s heartbeat) and get `playback` SSE events; a device that was playing pauses and offers "Phát ở đây" (GET `/api/playback` returns the session with its tracks). There is one player bar: while another device plays, the bar / mini player show that device (`web/src/player/view.ts`: `useRemoteView`, `useView*`, and `ctl.*` which sends remote commands or drives the local engine), and the sheet `RemoteSheet` holds the remote queue. Devices announce themselves (`POST /api/devices` every 30 s; `GET /api/devices` lists the ones seen in 90 s); the device picker moves playback with the `takeOver` command (the target continues the session; a paused report from another device never replaces a playing session). Other devices show the playing one (song, extrapolated progress, volume, queue) and control it: `POST /api/playback/command` → SSE `remote-cmd` to the target device (play, pause, toggle, next, prev, seek, volume, jump/remove/move in the upcoming list by index + expected track id, playNow, queue, shuffle, repeat). Discord presence is fed from the same reports. State is in memory.

## Nghe chung

Files: `rooms.go`, `web/src/player/room.ts`, `roomFlag.ts`.

In-memory rooms with a 6-character code (no 0/O/1/I). One slot per account; roles host / controller / listener (joiners are listeners; the host changes roles). State `{queue, index, positionMs, playing, updatedAt, rev, by}` is set by the host or controllers (their local player changes are sent, debounced) and broadcast as SSE `room` events with the server time (`now`) so clients correct clock skew; members load the queue, seek and play/pause, and correct drift over 2.5 s every 10 s. Listeners' local changes are undone. Heartbeat every 20 s; silent for 60 s = disconnected; a room closes when the host leaves or closes it, or after 5 minutes with nobody connected. `/api/rooms/mine` rejoins after a reload. Members may stream the room's songs even without them in their library (`canAccess` → `roomCanAccess`).

## Sound effects

Files: `web/src/player/fx.ts`.

Web Audio chain between the master gain and the output: 10-band EQ with pre-gain, exciter (harmonic waveshaper on the 3.5 kHz+ band), bass shelf, crossfeed (bs2b-style), mid/side width, limiter. Per device in localStorage (`rii-fx`), bypassed when off. Not available in simple mode (no Web Audio).

## Offline

Files: `web/src/sw.ts`, `web/src/offline/idb.ts`, `web/src/lib/offline.ts`.

Our own service worker (vite-plugin-pwa `injectManifest`; typechecked with `tsconfig.sw.json`). Songs live in IndexedDB `rii-offline` and are served by the service worker for `/api/tracks/{id}/stream` with Range support, online or not. With offline mode on (setting stored in IndexedDB so the SW can read it), library GETs are network-first into the `rii-api` cache. Auto-stored songs (played 20 s) expire after 30/60/90 days since last use; pinned ones ("Lưu offline" in a song's ⋯ menu) stay; "Tải về máy" is a real file download (`/api/tracks/{id}/stream?download=1`, named "Artist - Title.ext", not served by the service worker). Logout clears both.

## Enrichment worker

Files: `enrich.go`, migration 0002.

One track at a time: LRCLIB lyrics written into the file tags with an ffmpeg stream copy (`lyrics_embedded`), Deezer album genres (+ Last.fm tags with a key) into `tracks.genres`, MusicBrainz check (1 req/s) only for `meta_source = 'heuristic'`. Failures are retried hourly. Smart playlists support `{type: "genre"}`; `GET /api/genres`.

## Versioning / CI

`VERSION` = major.minor; release builds are `<major.minor>.<run number>`, linked with `-X rii_music/internal/server.Version=…` (shown by `/api/health`, OpenAPI, Settings → About). `.github/workflows/ci.yml` runs vet + tests against a Postgres service; `release.yml` on push to `main` tests, then publishes binaries and a GHCR image.
