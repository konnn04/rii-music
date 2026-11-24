# Desktop app

RiiMusic Desktop (Windows, macOS, Linux) wraps the same web app in a native window (Tauri v2). Installers and the portable build are on the [releases page](https://github.com/konnn04/rii-music/releases) (`desktop-v*`); the app updates itself from there.

## Two modes

The first start asks which one to use; **Settings → Desktop app → Đổi chế độ** (switch mode) asks again later.

- **Nghe trên máy này** (local): no server, no account. The app runs its own server and PostgreSQL on `127.0.0.1` and signs you in automatically. PostgreSQL and ffmpeg are downloaded on first start of this mode only, so the first start takes a few minutes.
  - Music is stored **encrypted** in `~/Music/RiiMusic` (Windows: `%USERPROFILE%\Music\RiiMusic`); the files only play inside the app. Settings → Desktop app moves the folder elsewhere.
  - Everything else (database, key, cache, logs) is in the app data folder: Windows `%LOCALAPPDATA%\RiiMusic`, macOS `~/Library/Application Support/RiiMusic`, Linux `~/.local/share/RiiMusic`. Back up `vault.key` from there together with the music folder, or the music can't be read.
- **Kết nối máy chủ** (client): uses an existing RiiMusic server (enter its address); you sign in as on the web.

## Extras over the web app

- Runs in the tray; closing the window keeps the music playing. Start with the computer (Settings → Desktop app).
- Media keys, and on Windows prev / play-pause / next buttons in the taskbar preview.
- **Mini player**: a small always-on-top window (player bar ⋯ → Trình phát mini, or the tray menu).
- Notifications when a download you started finishes while the window is hidden.
- Discord "Listening to…" status straight to Discord on the same computer, no agent or token ([discord.md](discord.md)).
- Device name: the computer's name in the device picker (can be changed in Settings).
- Links `riimusic://room/<code>` open the app and join a Nghe chung room; `riimusic://track/<id>` plays a song.

## Logs

The shell writes `logs/desktop.log` in the app data folder (the server's own log is in it too, prefixed `[server]`). Attach it when reporting a problem; it never contains passwords or tokens.

## Building it yourself

See [desktop/README.md](../desktop/README.md). Windows builds are not code-signed yet, so SmartScreen warns on first run ("More info → Run anyway").
