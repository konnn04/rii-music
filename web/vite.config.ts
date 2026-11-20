import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

// One canonical absolute path for root and "@": on Windows the drive letter's
// case can differ between cwd and import.meta.url, and Vite would then load
// the same file twice as two modules (two player stores, two audio engines).
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  resolve: { alias: { "@": here + "src" } },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Vang",
        short_name: "Vang",
        description: "Nghe nhạc cá nhân",
        lang: "vi",
        theme_color: "#0E0F12",
        background_color: "#0E0F12",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /^\/api\/tracks\/[^/]+\/cover/.test(url.pathname),
            handler: "CacheFirst",
            options: { cacheName: "covers", expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
