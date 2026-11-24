# Features

## Playback

- Play, seek, shuffle, repeat; crossfade, gapless playback within an album, loudness normalisation between songs.
- Drag-and-drop queue, "play next", save the queue as a playlist. The queue separates what you picked from autoplay suggestions.
- Synced lyrics from LRCLIB, with offset adjustment, picking another version or pasting your own; full-screen lyrics (key `L`).
- Lock-screen and notification controls (Media Session); installable as an app (PWA).
- **Karaoke** (key `K`, or ⋯ → Karaoke): big synced lyrics with a fill per line and a countdown, key shift −6…+6 semitones. Vocals: **Nhanh** (quick) removes centre vocals live, with a vocal level slider; **AI** separates the vocals in the browser with an MDX-Net model (downloads ~65 MB once, then a few minutes per song — much faster with WebGPU), and caches the instrumental on the device (Settings → Sound clears it).
- Sleep timer: 5–90 minutes with a fade-out, or "at the end of this song".
- Sound settings on the device: 10-band EQ with presets, bass boost, exciter, headphone crossfeed, stereo width, limiter.
- Visuals: bass-reactive background, 12 accent colours or the cover's colour, cover transition from the mini player to Now Playing.
- Lite mode (Settings → Appearance): fewer effects (no bass pulse, blur, cover transition, most animations) so weak devices play smoothly; on automatically for low-end hardware, reduced-motion devices, or when frames drop during playback.
- Right-click (or long-press) any card on Home or in the Library: play, shuffle, play next, add to the queue, add to a playlist.
- On phones and tablets the page always opens at 100 % volume (the hardware buttons control it); computers keep the last volume. UI scale setting on phones.

## Devices and listening together

- One player at a time across tabs and devices. While another device plays, the player bar shows it and its buttons control it (song, progress, volume, queue), like Spotify Connect. The device picker moves playback to another open device or to this one.
- **Nghe chung** (listen together): "Phát trạm" opens a room with a 6-character code; friends join with the code and hear the same thing in sync. Roles: host, controller, listener (default). Reconnects automatically; the room closes when the host leaves or nobody has been connected for 5 minutes.

## Offline

- Off by default (Settings → Offline listening). Keeps the app, your library and the songs you play on the device for 30, 60 or 90 days.
- "Lưu offline" (save offline) in a song's ⋯ menu keeps a song until removed; "Tải về máy" (download) saves the audio file as `Artist - Title.m4a` with tags, cover and lyrics.
- Without a connection only stored songs play; the others are skipped and shown dimmed.

## Finding and downloading music

- Search YouTube Music for songs, albums, playlists and videos. Press play: songs you have play at once, others download and then play.
- Album and playlist pages; save a whole album as a playlist.
- Artist pages: your songs (featured ones too), plus the artist's songs and albums on YouTube Music. Follow artists; followed artists are listed in the sidebar and in Library → Artists.
- Library filters (text, language, genre, artist, album, liked, plays, date added, length); drag songs onto sidebar playlists.
- Downloads run in a queue (paste links or search words, one per line, in the "Tải nhạc" dialog). Files are shared: a song already on the server is linked, not downloaded again.
- After download, in the background: lyrics embedded in the file, genres from Deezer / Last.fm, names of unofficial uploads checked on MusicBrainz.

## Recommendations

- Autoplay when the queue runs low, in the language of the current song.
- Daily mixes, radio from a song, similar artists, mood playlists (chat with the mascot Vani), smart playlists (top, recent, unplayed, by artist, by genre).
- "Sounds like": timbre (MFCC), harmony (chroma), spectrum, energy and tempo.
- "Không thích" (don't like) a song or an artist: never suggested again; managed in Settings.
- Songs played to the end in the last 3 hours are not repeated in radio, mixes or autoplay; nothing already in the queue is suggested.
- Optional auto-download of songs you are likely to like, within your storage limit.
- Listening streak: days in a row with at least 10 minutes of music. Vani, the mascot, grows through 7 stages with your best streak (sprout, cherry, DJ sunglasses, star, crown, cosmic halo) and never shrinks back.
- Song language comes from the title, the artist and the lyrics (romanised Japanese included), so recommendations don't mix languages.
- Recommendations keep to the style of what plays (genres from Last.fm and Deezer, folded into styles such as bolero, V-pop, rap, EDM, lofi) and to its kind: after a regular song, no hour-long lofi mixes, BGM, karaoke or medleys. New users with small libraries get more new songs. The genres of the current song show in the Now Playing panel; admins can re-tag the whole library ("Đồng bộ lại") and see the progress. Last.fm and Deezer quotas are respected: on a limit the server pauses and resumes by itself.

## Accounts and administration

- Sign in with a password or a one-time code by email; password reset by code. Emails are HTML with a plain-text part; code emails start their subject with the code so mail apps recognise it.
- Admin: suggestion and download limits (songs autoplay keeps queued and downloads, auto-download per run, songs per playlist link), users and storage limits, system status and logs, yt-dlp updates, download format, site name / logo / description, Discord application id.
- Share a song by link: signed-out visitors get a 30-second preview.
- Interface in Vietnamese and English.

## Desktop app

- Windows / macOS / Linux app with a local mode (no server, encrypted music folder) or as a client of a server; tray, autostart, media keys, mini player, taskbar buttons, notifications, self-update ([desktop.md](desktop.md)).

## Integrations

- Discord "Listening to…" status with a one-line agent, nothing to install ([discord.md](discord.md)).
- HTTP API with personal tokens, OpenAPI docs and a one-file TypeScript client ([api.md](api.md)), including streaming any YouTube video's audio without downloading it (for bots).
