# API

Everything the web app does goes through the same HTTP API.

- **Tokens:** create one in Settings → API, then send `Authorization: Bearer <token>`. Tokens can be revoked at any time. (Browser sessions use a cookie plus the `X-RiiMusic` header on changes; token calls don't need the header.)
- **Reference:** `/docs` on your server, generated from OpenAPI 3.1 at `/api/openapi.json`.
- **TypeScript client:** one file at `/api/docs/client.ts`.
- **Realtime:** `/api/events` is a server-sent event stream per user (download progress, library changes, playback on your other devices, remote commands, listening rooms).

## Streaming without downloading (bots)

`GET /api/stream/{videoId}` plays a YouTube video's audio through the server, without adding it to a library: yt-dlp resolves the best audio format (Opus/WebM or AAC/M4A), the server proxies it with Range support, so a client (e.g. a Discord bot with ffmpeg) can read it like a file. `GET /api/stream/{videoId}/info` returns the title, artist, duration and format. If the song is already in your library it is served from disk. The first request for a video takes a few seconds (yt-dlp); the link is cached for 4 hours and concurrent requests share one lookup. Search with `GET /api/search?scope=web&q=…` to get video ids.

```bash
curl -H "Authorization: Bearer rii_…" https://music.example.com/api/stream/kJQP7kiw5Fk/info
ffmpeg -headers "Authorization: Bearer rii_…" -i https://music.example.com/api/stream/kJQP7kiw5Fk -f s16le -ar 48000 -ac 2 pipe:1
```

## Examples



```bash
curl -H "Authorization: Bearer rii_…" https://music.example.com/api/tracks?sort=added
curl -X POST -H "Authorization: Bearer rii_…" -H "Content-Type: application/json" \
     -d '{"input":"https://music.youtube.com/watch?v=…"}' https://music.example.com/api/downloads
```
