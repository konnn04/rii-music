# Configuration

Settings come from `.env` (read at start-up, path from `ENV_FILE`) or real environment variables, which take precedence. Never commit `.env`: it holds passwords.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@riimusic.local` / random, printed in the log | First admin account, created only when there are no accounts |
| `DATABASE_URL` | set by Compose | PostgreSQL connection string, e.g. `postgres://rii:secret@localhost:5432/rii_music?sslmode=disable` |
| `POSTGRES_PASSWORD` | | PostgreSQL password in Docker Compose (letters and digits) |
| `PUBLIC_URL` | | Public https address of the site |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | | Mail account, e.g. Gmail with an app password. Without them, sign-in by code and password reset are off |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `587` | Mail server (465 = implicit TLS) |
| `SMTP_FROM` | `SMTP_USERNAME` | Sender, `Name <address>` |
| `DEFAULT_STORAGE_LIMIT_MB` | `2048` | Music storage for new accounts |
| `LASTFM_API_KEY` | | Use Last.fm instead of Deezer for similar artists and tags |
| `DATA_DIR` | `./data` | Music, covers, previews, yt-dlp, `secret.key`, `cookies.txt` |
| `PORT` | `8080` | HTTP port |
| `TRUST_PROXY` | `false` (Docker: `true`) | Take the client IP from the reverse proxy |
| `DOWNLOAD_CONCURRENCY` | `2` | Songs downloaded at the same time |
| `MAX_DURATION_SEC` | `10800` | Longer videos are refused |
| `YT_COOKIES_PATH` | `$DATA_DIR/cookies.txt` | YouTube cookies, when YouTube asks to confirm you are not a bot |
| `YTDLP_PATH` | managed | Use an installed yt-dlp instead of the managed nightly build |
| `YTDLP_GEO_COUNTRY` | | Pretend to be in a country, e.g. `VN` |
| `YTDLP_MAX_PROCS` | `3` | Maximum concurrent yt-dlp processes |
| `KARAOKE_MODEL_BASE_URL` | UVR's public model releases on GitHub | Folder the server downloads the karaoke separation models (`UVR_MDXNET_KARA.onnx`, `UVR_MDXNET_KARA_2.onnx`, `UVR-MDX-NET-Inst_HQ_3.onnx`) from, each the first time someone picks it |
| `FORCE_IPV4` | `false` | IPv4 only, for yt-dlp (`--force-ipv4`) and every outbound connection (YouTube Music, LRCLIB, Deezer, SMTP…) |
| `FFMPEG_PATH` | `ffmpeg` | |
| `LOG_LEVEL` | `info` | `debug` logs every request |
| `ENV_FILE` | `.env` | Path of the settings file |

## Advanced

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_DIR` | | Serve the UI from this directory instead of the embedded build (development) |
| `YTDLP_JS_RUNTIME` | deno, then node | JavaScript runtime yt-dlp uses for YouTube |
| `YTDLP_REMOTE_EJS` | `true` | Pass `--remote-components ejs:github` to yt-dlp |
| `AGENT_DIR` | `/opt/rii_music/agent` in Docker | Prebuilt Discord agent executables (only with the `AGENT_BINARIES=true` build) |
| `TZ` | `Asia/Ho_Chi_Minh` in Docker | Time zone of the logs |

## In the app

The admin page (Quản trị) holds the rest: download format (m4a / Opus) and bitrate, the Discord application id, the site name, logo and description, users and storage limits, and buttons to update yt-dlp and send a test email.

Each user's settings (theme, accent, crossfade, autoplay mode, offline listening, sound effects, dislikes, Discord status, API tokens) are in Settings (Cài đặt).
