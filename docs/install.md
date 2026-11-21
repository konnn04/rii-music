# Installation

## Docker (recommended)

Needs Docker with Compose.

```bash
git clone https://github.com/konnn04/rii-music.git rii_music && cd rii_music
cp .env.example .env     # set at least POSTGRES_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD, PUBLIC_URL
docker compose up -d --build
```

Compose runs two containers: the app and PostgreSQL (reachable only by the app). Open `http://<server>:8080` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. On first start the server creates its tables and downloads yt-dlp (`docker compose logs -f` to follow).

Prebuilt images are published to GHCR on every release ([releases.md](releases.md)).

## From source

Needs Go 1.27+, Node 22+ with pnpm, ffmpeg on the PATH, and PostgreSQL 14+ with an empty database.

```bash
cp .env.example .env          # set DATABASE_URL to your PostgreSQL
cd web && pnpm install && pnpm build && cd ..
go build -o rii_music .       # Windows: go build -o rii_music.exe .
./rii_music                   # Windows: .\rii_music.exe
```

Open http://localhost:8080; stop with Ctrl+C. The web app is embedded in the binary at build time, so after changing the UI run `pnpm build` before `go build`.

Release binaries for Linux, Windows and macOS are also published ([releases.md](releases.md)); they still need ffmpeg and PostgreSQL.

## On the Internet

- Put it behind a reverse proxy with HTTPS, e.g. Caddy: `music.example.com { reverse_proxy localhost:8080 }`.
- Set `PUBLIC_URL=https://music.example.com` (used in emails, share links and Discord artwork) and `TRUST_PROXY=true`.
- Server-sent events must not be buffered. Caddy is fine as is; with Nginx add `proxy_buffering off;` for `/api/events`.
- Service workers (offline mode) need HTTPS, except on `localhost`.

## Updates

```bash
git pull && docker compose up -d --build
```

The database upgrades itself: numbered migrations run once, in order, under a lock. Check with `docker compose exec rii_music rii_music migrate status` (or `./rii_music migrate status`).

## Backups

- Database: `docker compose exec postgres pg_dump -U rii rii_music > backup.sql`.
- Files (music, covers, `secret.key`, `cookies.txt`): the `rii_music-data` volume, or `DATA_DIR` when running from source. Keep `secret.key`: it signs sessions and share links.
