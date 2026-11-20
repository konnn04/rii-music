import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Tooltip } from "radix-ui";
import { useEffect } from "react";
import { api, ApiError, type Me } from "./lib/api";
import { queryClient } from "./lib/queries";
import { AppShell } from "./components/layout/AppShell";
import { Toaster } from "./components/ui/Toast";
import { Spinner } from "./components/ui/misc";
import { Login } from "./pages/Login";
import { HomePage } from "./pages/Home";
import { SearchPage } from "./pages/Search";
import { LibraryPage, type LibTab } from "./pages/Library";
import { AlbumPage, ArtistPage, PlaylistPage } from "./pages/Detail";
import { DownloadsPage } from "./pages/Downloads";
import { HistoryPage } from "./pages/History";
import { SettingsPage } from "./pages/Settings";
import { DiscoverPage } from "./pages/Discover";
import { AdminPage } from "./pages/Admin";
import { SharePage } from "./pages/Share";
import { DocsPage } from "./pages/Docs";
import { t } from "./i18n";
import type { TrackSort } from "./lib/queries";

function Root() {
  // Public pages: a shared song and the API docs work signed out.
  const path = location.pathname;
  if (path.startsWith("/s/")) return <Public><SharePage token={decodeURIComponent(path.slice(3))} /></Public>;
  if (path === "/docs" || path.startsWith("/docs/")) return <Public><DocsPage /></Public>;
  return <Private />;
}

function Public({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={500}>
      {children}
      <Toaster />
    </Tooltip.Provider>
  );
}

function Private() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/api/me"),
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 3,
    staleTime: 60_000,
  });
  // The queue lives in localStorage: a different account on this browser
  // starts with an empty one instead of the previous person's.
  const uid = me.data?.user.id;
  useEffect(() => {
    if (!uid) return;
    const prev = localStorage.getItem("vang-uid");
    if (prev === uid) return;
    localStorage.setItem("vang-uid", uid);
    if (prev !== null || localStorage.getItem("vang-player")) {
      localStorage.removeItem("vang-player");
      localStorage.removeItem("vang-pos");
      location.reload();
    }
  }, [uid]);
  let body;
  if (me.isLoading) body = <Spinner className="h-dvh" />;
  else if (me.error instanceof ApiError && me.error.status === 401)
    body = (
      <Login
        onDone={() => {
          queryClient.clear();
          me.refetch();
        }}
      />
    );
  else body = <AppShell />;
  return (
    <Tooltip.Provider delayDuration={500}>
      {body}
      <Toaster />
    </Tooltip.Provider>
  );
}

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: () => <p className="p-8 text-body text-fg-muted">{t("common.notFound")}</p>,
});

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/search",
    component: SearchPage,
    validateSearch: (s: Record<string, unknown>): { q?: string; scope?: "library" | "web" } => ({
      q: str(s.q),
      scope: s.scope === "web" ? "web" : undefined,
    }),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/library",
    component: LibraryPage,
    validateSearch: (s: Record<string, unknown>): { tab?: LibTab; sort?: TrackSort } => ({
      tab: (["songs", "artists", "albums", "playlists"] as const).find((t) => t === s.tab),
      sort: (["added", "title", "artist", "plays"] as const).find((t) => t === s.sort),
    }),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/playlist/$id", component: PlaylistPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/album/$artist/$name", component: AlbumPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/artist/$name", component: ArtistPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/downloads", component: DownloadsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/discover", component: DiscoverPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/history", component: HistoryPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin",
    component: AdminPage,
    validateSearch: (s: Record<string, unknown>): { tab?: "users" | "system"; user?: string } => ({
      tab: s.tab === "system" ? "system" : undefined,
      user: str(s.user),
    }),
  }),
];

export const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  defaultPreload: false,
  scrollRestoration: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
