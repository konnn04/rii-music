/// <reference lib="webworker" />
// Service worker: the app shell (precached), covers, and — only when offline
// mode is on (Settings → Nghe offline) — the library data and the songs
// stored in IndexedDB, so music keeps playing without a connection.

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { clientsClaim } from "workbox-core";
import { getAudio, getSettings, touchAudio } from "./offline/idb";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigations → index.html (not the API, share audio, agent scripts, robots…).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/__rii\//, /^\/agent\./, /^\/download\//, /^\/branding\//, /^\/robots\.txt/, /^\/manifest/],
  }),
);

registerRoute(
  ({ url }) => /^\/api\/tracks\/[^/]+\/cover/.test(url.pathname),
  new CacheFirst({ cacheName: "covers", plugins: [new ExpirationPlugin({ maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 90 })] }),
);

// ── songs: from IndexedDB when stored, else the network ─────────────────
const STREAM = /^\/api\/tracks\/([^/]+)\/stream$/;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  const m = STREAM.exec(url.pathname);
  if (!m || url.searchParams.has("download")) return; // "Tải về máy" saves the server's file
  event.respondWith(streamFromStore(m[1], event.request));
});

async function streamFromStore(id: string, req: Request): Promise<Response> {
  const e = await getAudio(id).catch(() => undefined);
  if (!e) return fetch(req);
  void touchAudio(id).catch(() => {});
  const size = e.blob.size;
  const range = req.headers.get("range");
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) {
    return new Response(e.blob, { status: 200, headers: { "Content-Type": e.mime, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  }
  // The <audio> element seeks with Range requests.
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (!m[1] && m[2]) {
    start = Math.max(0, size - parseInt(m[2], 10)); // suffix range: last N bytes
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(e.blob.slice(start, end + 1, e.mime), {
    status: 206,
    headers: {
      "Content-Type": e.mime,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

// ── library data: network first, cached copy when offline (offline mode only) ──
const apiNetworkFirst = new NetworkFirst({
  cacheName: "rii-api",
  networkTimeoutSeconds: 5,
  plugins: [new ExpirationPlugin({ maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 90 })],
});
// What the library pages read (songs and covers are handled above).
const CACHED_API = /^\/api\/(me|settings|home|tracks|artists|artist|albums|album|playlists|history|stats|branding|genres)(\/.*)?$/;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (!CACHED_API.test(url.pathname) || STREAM.test(url.pathname) || url.pathname.endsWith("/cover")) return;
  event.respondWith(
    getSettings().then((s) => (s.enabled ? apiNetworkFirst.handle({ event, request: event.request }) : fetch(event.request))),
  );
});

// Signed out (or offline mode turned off): drop the cached personal data.
self.addEventListener("message", (event) => {
  if (event.data?.type === "clear-api-cache") event.waitUntil(caches.delete("rii-api"));
});
