<p align="center">
  <img src="web/public/icon.png" alt="RiiMusic" width="128" />
</p>

# RiiMusic

Self-hosted music for you and your friends. Find and download songs from YouTube Music, keep a library per person, and listen on phones and computers like a native app.

One Go binary serves the web app and the API; data lives in PostgreSQL, music files in a folder.

## Highlights

- Full player: crossfade, gapless albums, loudness levelling, synced lyrics, sleep timer, EQ and sound effects, lock-screen controls, installable PWA.
- Spotify Connect–style control of your other devices, and **listening rooms** with a 6-character code.
- Recommendations that stay in one language: autoplay, daily mixes, radio, moods, "sounds like", with dislikes and no recent repeats.
- Offline listening, song file downloads, shared files across users, per-user storage limits.
- Accounts with password or email code, admin panel, share links with previews, Discord status, HTTP API.
- Interface in Vietnamese and English.

See [docs/features.md](docs/features.md) for the full list.



https://github.com/user-attachments/assets/0675e293-3449-4528-9492-48c28b9be3c9



## Quick start

```bash
git clone https://github.com/konnn04/rii-music.git rii_music && cd rii_music
cp .env.example .env      # set POSTGRES_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD, PUBLIC_URL
docker compose up -d --build
```

Open `http://<server>:8080` and sign in with the admin account. Running from source, reverse proxy, updates and backups: [docs/install.md](docs/install.md).

## Documentation

| | |
| --- | --- |
| [Features](docs/features.md) | What the app does |
| [Installation](docs/install.md) | Docker, source, HTTPS, updates, backups |
| [Configuration](docs/configuration.md) | Environment variables and admin settings |
| [Discord status](docs/discord.md) | "Listening to…" on Discord |
| [API](docs/api.md) | Tokens, OpenAPI, TypeScript client |
| [Troubleshooting](docs/troubleshooting.md) | Common problems |
| [Releases](docs/releases.md) | Versions, CI, release builds |
| [Architecture](docs/architecture.md) | How it works inside |

Contributing (commands, layout, conventions): [AGENTS.md](AGENTS.md).
