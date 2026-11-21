# API

Everything the web app does goes through the same HTTP API.

- **Tokens:** create one in Settings → API, then send `Authorization: Bearer <token>`. Tokens can be revoked at any time. (Browser sessions use a cookie plus the `X-RiiMusic` header on changes; token calls don't need the header.)
- **Reference:** `/docs` on your server, generated from OpenAPI 3.1 at `/api/openapi.json`.
- **TypeScript client:** one file at `/api/docs/client.ts`.
- **Realtime:** `/api/events` is a server-sent event stream per user (download progress, library changes, playback on your other devices, remote commands, listening rooms).

Example:

```bash
curl -H "Authorization: Bearer rii_…" https://music.example.com/api/tracks?sort=added
curl -X POST -H "Authorization: Bearer rii_…" -H "Content-Type: application/json" \
     -d '{"input":"https://music.youtube.com/watch?v=…"}' https://music.example.com/api/downloads
```
