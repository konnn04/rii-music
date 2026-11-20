import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useIsDesktop } from "@/lib/useMedia";
import { queryClient, useJobs, useMe, usePlaylists, useSettings, useToggleLike } from "@/lib/queries";
import { api, type Playlist } from "@/lib/api";
import { engine } from "@/player/engine";
import { usePlayer } from "@/player/store";
import { useShortcuts } from "@/player/shortcuts";
import { startSync } from "@/player/sync";
import { applyAccent, applyTheme } from "@/lib/theme";
import { connectEvents } from "@/lib/events";
import { Icon, type IconName } from "../ui/Icon";
import { IconButton } from "../ui/Button";
import { Collage } from "../ui/Cover";
import { toast } from "../ui/Toast";
import { TRACK_DRAG_MIME, useScrollEl } from "../TrackList";
import { GlobalDialogs, openDialog } from "../dialogs";
import { MiniPlayer, PlayerBar } from "./PlayerBar";
import { LyricsFullscreen, MobileNowPlaying, RightPanel } from "./NowPlaying";
import { Tooltip } from "../ui/Tooltip";
import { t, tn, syncLang } from "@/i18n";
import { useBranding } from "@/lib/branding";
import { Onboarding } from "@/pages/Onboarding";
import { RemoteBanner } from "@/components/RemoteBanner";
import { clearStored, initOffline, useOffline } from "@/lib/offline";

// `header`: shown as an icon in the top bar (desktop) and the mobile header
// instead of the sidebar / tab bar; tablets (no top bar) keep it in the sidebar.
const nav: { to: string; key: string; icon: IconName; mobile?: boolean; admin?: boolean; header?: boolean }[] = [
  { to: "/", key: "home", icon: "home", mobile: true },
  { to: "/search", key: "search", icon: "search", mobile: true },
  { to: "/library", key: "library", icon: "library", mobile: true },
  { to: "/discover", key: "discover", icon: "radio" },
  { to: "/downloads", key: "downloads", icon: "download", header: true },
  { to: "/history", key: "history", icon: "stats" },
  { to: "/settings", key: "settings", icon: "settings", mobile: true },
  { to: "/admin", key: "admin", icon: "shield", admin: true, header: true },
];
const label = (k: string) => t(`common.nav.${k}`);

export function AppShell() {
  const scrollEl = useScrollEl((s) => s.el);
  const setScrollEl = useCallback((el: HTMLElement | null) => useScrollEl.setState({ el }), []);
  const desktop = useIsDesktop();
  const settings = useSettings();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    engine.init();
    startSync(); // one player at a time across tabs and devices
    void initOffline();
    connectEvents();
  }, []);
  useEffect(() => {
    if (!settings.data) return;
    engine.configure(settings.data);
    applyTheme(settings.data.theme);
    applyAccent(settings.data.accent);
    syncLang(settings.data.language);
  }, [settings.data]);
  useEffect(() => {
    scrollEl?.scrollTo({ top: 0 });
  }, [pathname, scrollEl]);
  // Mobile Now Playing is not used on desktop: the right panel takes over.
  useEffect(() => {
    if (desktop && usePlayer.getState().npOpen) usePlayer.getState().setNp(false);
  }, [desktop]);
  useShortcuts();

  return (
    <>
      <div className="flex h-dvh flex-col overflow-hidden bg-canvas">
        <MobileHeader />
        <div className="flex min-h-0 flex-1 gap-2 md:p-2 md:pb-0">
          <Sidebar />
          <main ref={setScrollEl} className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden md:rounded-card" id="main">
            <div className="min-h-full pb-[calc(var(--spacing-tabbar)+var(--spacing-miniplayer)+24px+env(safe-area-inset-bottom))] md:pb-8">
              <TopBar />
              <div className="mx-auto w-full max-w-[1280px]">
                <Outlet />
              </div>
            </div>
          </main>
          <RightPanel />
        </div>
        <RemoteBanner className="mx-2 mb-1 hidden md:flex" />
        <PlayerBar />
        <div className="fixed inset-x-0 bottom-0 z-[40] md:hidden">
          <RemoteBanner className="mx-2 mb-1" />
          <MiniPlayer />
          <TabBar />
        </div>
      </div>
      {!desktop && <MobileNowPlaying />}
      <LyricsFullscreen />
      <OfflineBanner />
      <GlobalDialogs />
      {settings.data && !settings.data.onboarded && <Onboarding />}
    </>
  );
}

function useActiveJobs() {
  const { data } = useJobs();
  return data?.jobs.filter((j) => j.status === "queued" || j.status === "downloading" || j.status === "processing").length ?? 0;
}

function isActive(pathname: string, to: string) {
  return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(to + "/");
}

function TabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const jobs = useActiveJobs();
  return (
    <nav className="flex h-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] items-start justify-around bg-canvas/95 pb-safe backdrop-blur" aria-label={t("common.nav.mainNav")}>
      {nav
        .filter((n) => n.mobile)
        .map((n) => {
          const on = isActive(pathname, n.to);
          return (
            <Link
              key={n.to}
              to={n.to}
              className={`focus-ring relative flex h-[var(--spacing-tabbar)] min-w-16 flex-col items-center justify-center gap-0.5 rounded-control text-caption ${on ? "text-fg" : "text-fg-muted"}`}
              aria-current={on ? "page" : undefined}
            >
              <Icon name={n.icon} size={24} className={on ? "text-accent" : ""} />
              {n.key === "search" ? t("common.nav.searchShort") : label(n.key)}
              {n.to === "/downloads" && jobs > 0 && (
                <span className="absolute right-3 top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-fg-on-accent">{jobs}</span>
              )}
            </Link>
          );
        })}
    </nav>
  );
}

function hasTrackDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(TRACK_DRAG_MIME);
}

function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const desktop = useIsDesktop();
  const jobs = useActiveJobs();
  const playlists = usePlaylists();
  const navigate = useNavigate();
  const isAdmin = useMe().data?.user.role === "admin";
  const brand = useBranding();
  const toggleLike = useToggleLike();
  const [draggingTracks, setDraggingTracks] = useState(false);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  useEffect(() => {
    const onStart = (e: DragEvent) => {
      if (hasTrackDrag(e.dataTransfer)) setDraggingTracks(true);
    };
    const onEnd = () => {
      setDraggingTracks(false);
      setDropTargetId(null);
    };
    window.addEventListener("dragstart", onStart);
    window.addEventListener("dragend", onEnd);
    return () => {
      window.removeEventListener("dragstart", onStart);
      window.removeEventListener("dragend", onEnd);
    };
  }, []);

  const handleDrop = async (e: ReactDragEvent<HTMLButtonElement>, p: Playlist) => {
    if (!hasTrackDrag(e.dataTransfer)) return;
    e.preventDefault();
    setDropTargetId(null);
    setDraggingTracks(false);
    let ids: string[] = [];
    try {
      const parsed: unknown = JSON.parse(e.dataTransfer.getData(TRACK_DRAG_MIME));
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
    } catch {
      return;
    }
    if (!ids.length) return;
    const name = p.id === "liked" ? t("common.nav.liked") : p.name;
    try {
      if (p.id === "liked") {
        await Promise.all(ids.map((id) => toggleLike.mutateAsync({ id, liked: true })));
      } else {
        await api(`/api/playlists/${p.id}/items`, { method: "POST", json: { trackIds: ids } });
        queryClient.invalidateQueries({ queryKey: ["playlists"] });
        queryClient.invalidateQueries({ queryKey: ["playlist", p.id] });
      }
      toast(t("ui.drag.added", { n: ids.length, name }), "success");
    } catch (err) {
      if (p.id !== "liked") {
        toast((err as Error)?.message ?? t("common.error"), "error");
      }
    }
  };

  return (
    <aside
      className="hidden w-[var(--spacing-sidebar-collapsed)] shrink-0 flex-col gap-2 md:flex lg:w-[var(--spacing-sidebar)]"
      aria-label={t("common.nav.sidebar")}
    >
      <nav className="flex flex-col gap-1 rounded-card bg-surface-1 p-2" aria-label={t("common.nav.mainNav")}>
        <div className="mb-1 hidden h-12 items-center gap-2 px-3 lg:flex">
          <img src={brand.logoUrl} alt="" className="size-7 rounded-xs object-contain" />
          <span className="truncate text-title-3 tracking-tight">{brand.name}</span>
        </div>
        {nav.filter((n) => !n.admin || isAdmin).map((n) => {
          const on = isActive(pathname, n.to);
          const link = (
            <Link
              key={n.to}
              to={n.to}
              aria-current={on ? "page" : undefined}
              aria-label={label(n.key)}
              className={`focus-ring state-layer relative flex h-11 items-center justify-center gap-3 rounded-control px-3 text-label lg:justify-start ${
                on ? "bg-accent-soft text-fg" : "text-fg-muted hover:text-fg"
              } ${n.header ? "lg:hidden" : ""}`}
            >
              <Icon name={n.icon} className={on ? "text-accent" : ""} />
              <span className="hidden truncate lg:inline">{label(n.key)}</span>
              {n.to === "/downloads" && jobs > 0 && (
                <span className="absolute right-1 top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-fg-on-accent lg:static lg:ml-auto lg:min-w-5 lg:text-caption lg:leading-5">
                  {jobs}
                </span>
              )}
            </Link>
          );
          return desktop ? link : <Tooltip key={n.to} content={label(n.key)} side="right">{link}</Tooltip>;
        })}
      </nav>
      <section className="hidden min-h-0 flex-1 flex-col rounded-card bg-surface-1 p-2 lg:flex" aria-label="Playlist">
        <div className="flex h-11 items-center justify-between px-3">
          <span className="text-overline uppercase text-fg-subtle">{t("common.nav.playlists")}</span>
          <IconButton icon="plus" label={t("common.nav.newPlaylist")} onClick={() => openDialog({ kind: "newPlaylist" })} size={20} className="-mr-2 size-9" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {playlists.data?.map((p) => {
            const on = pathname === `/playlist/${p.id}`;
            const canDrop = p.kind === "manual" || p.id === "liked";
            const isOver = canDrop && dropTargetId === p.id;
            return (
              <button
                key={p.id}
                onClick={() => navigate({ to: "/playlist/$id", params: { id: p.id } })}
                onDragOver={
                  canDrop
                    ? (e) => {
                        if (!hasTrackDrag(e.dataTransfer)) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                        if (dropTargetId !== p.id) setDropTargetId(p.id);
                      }
                    : undefined
                }
                onDragLeave={
                  canDrop
                    ? (e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          setDropTargetId((cur) => (cur === p.id ? null : cur));
                        }
                      }
                    : undefined
                }
                onDrop={canDrop ? (e) => void handleDrop(e, p) : undefined}
                className={`focus-ring state-layer flex h-14 w-full items-center gap-3 rounded-control px-2 text-left transition-colors ${
                  isOver
                    ? "bg-accent-soft ring-2 ring-inset ring-accent"
                    : canDrop && draggingTracks
                      ? `${on ? "bg-surface-2" : ""} outline-1 outline-dashed outline-accent/50 -outline-offset-1`
                      : on
                        ? "bg-surface-2"
                        : ""
                }`}
              >
                {p.id === "liked" ? (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xs bg-accent-soft text-accent">
                    <Icon name="heart-filled" size={20} />
                  </span>
                ) : (
                  <Collage ids={p.coverTrackIds} size={40} rounded="rounded-xs" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-label">{p.id === "liked" ? t("common.nav.liked") : p.name}</span>
                  <span className="block truncate text-caption text-fg-muted">
                    {p.kind === "smart" ? t("common.nav.smart") + " · " : ""}
                    {tn("common.songs", p.trackCount)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </aside>
  );
}

function TopBar() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const qParam = useRouterState({ select: (s) => (s.location.search as { q?: string }).q ?? "" });
  const [q, setQ] = useState(qParam);
  useEffect(() => setQ(qParam), [qParam]);
  const timer = useRef<number | null>(null);

  const go = (v: string, replace = true) =>
    navigate({ to: "/search", search: (prev: Record<string, unknown>) => ({ ...prev, q: v || undefined }), replace: pathname === "/search" && replace });

  return (
    <div className="sticky top-0 z-[10] hidden h-[var(--spacing-topbar)] items-center gap-2 bg-canvas/90 px-4 backdrop-blur lg:flex">
      <IconButton icon="chevron-left" label={t("common.nav.backBtn")} onClick={() => history.back()} size={20} className="size-9 bg-surface-1" />
      <IconButton icon="chevron-right" label={t("common.nav.forwardBtn")} onClick={() => history.forward()} size={20} className="size-9 bg-surface-1" />
      <form
        role="search"
        className="relative ml-2 w-full max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          go(q, false);
        }}
      >
        <Icon name="search" size={20} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
        <input
          id="global-search"
          value={q}
          onChange={(e) => {
            const v = e.target.value;
            setQ(v);
            if (timer.current) clearTimeout(timer.current);
            timer.current = window.setTimeout(() => go(v), 250);
          }}
          placeholder={t("common.nav.searchPlaceholder")}
          aria-label={t("common.nav.search")}
          className="input h-11 w-full !rounded-full pl-10"
        />
      </form>
      <div className="ml-auto flex items-center gap-1">
        <HeaderLinks />
        <AccountChip />
        <LogoutButton />
      </div>
    </div>
  );
}

/** No connection: say so, and that only songs stored on this device play. */
function OfflineBanner() {
  const online = useOffline((s) => s.online);
  const enabled = useOffline((s) => s.enabled);
  if (online) return null;
  return (
    <div role="status" className="fixed left-1/2 top-[calc(8px+env(safe-area-inset-top))] z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full bg-surface-3 px-4 py-2 text-body-sm shadow-float">
      <Icon name="globe" size={16} className="text-warning" />
      {enabled ? t("ui.offline.onlyStored") : t("ui.offline.noConnection")}
    </div>
  );
}

/** Tải về (with the number of active downloads) and Quản trị as header icons. */
function HeaderLinks() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const jobs = useActiveJobs();
  const isAdmin = useMe().data?.user.role === "admin";
  return (
    <>
      {nav
        .filter((n) => n.header && (!n.admin || isAdmin))
        .map((n) => {
          const on = isActive(pathname, n.to);
          return (
            <Tooltip key={n.to} content={label(n.key)}>
              <Link
                to={n.to}
                aria-label={label(n.key)}
                aria-current={on ? "page" : undefined}
                className={`focus-ring state-layer relative flex size-10 items-center justify-center rounded-full ${on ? "text-accent" : "text-fg-muted hover:text-fg"}`}
              >
                <Icon name={n.icon} size={22} />
                {n.to === "/downloads" && jobs > 0 && (
                  <span className="absolute -right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-fg-on-accent">{jobs}</span>
                )}
              </Link>
            </Tooltip>
          );
        })}
    </>
  );
}

/** Who is signed in; links to Cài đặt. */
function AccountChip() {
  const me = useMe().data?.user;
  if (!me) return null;
  const label = me.name || me.email;
  return (
    <Link to="/settings" className="focus-ring state-layer flex h-9 max-w-56 items-center gap-2 rounded-full bg-surface-1 pl-1 pr-3" title={me.email}>
      <Avatar name={label} size={28} />
      <span className="truncate text-label">{label}</span>
      {me.role === "admin" && <span className="rounded-xs bg-accent-soft px-1.5 text-caption text-accent">Admin</span>}
    </Link>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const ch = (name.trim()[0] ?? "?").toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.45, background: `hsl(${h} 45% 42%)` }}
    >
      {ch}
    </span>
  );
}

/** Sign out and forget this browser's queue, so the next person starts fresh. */
export async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  engine.pause();
  localStorage.removeItem("rii-player");
  localStorage.removeItem("rii-pos");
  localStorage.removeItem("rii-uid");
  // This browser may be shared: forget the offline copies too.
  await clearStored().catch(() => {});
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-api-cache" });
  location.href = "/";
}

export function LogoutButton() {
  return <IconButton icon="logout" label={t("common.nav.logout")} size={20} onClick={logout} />;
}

/** Mobile: the app's name and logo (set by the admin), and the account. */
function MobileHeader() {
  const brand = useBranding();
  const me = useMe().data?.user;
  return (
    <header className="flex h-[calc(48px+env(safe-area-inset-top))] shrink-0 items-center gap-2 bg-canvas px-4 pt-safe md:hidden">
      <Link to="/" className="focus-ring flex min-w-0 items-center gap-2 rounded-control">
        <img src={brand.logoUrl} alt="" className="size-7 shrink-0 rounded-xs object-contain" />
        <span className="truncate text-title-3 tracking-tight">{brand.name}</span>
      </Link>
      <div className="ml-auto flex items-center gap-1">
        <Link to="/discover" className="focus-ring flex size-10 items-center justify-center rounded-full text-fg-muted" aria-label={label("discover")}>
          <Icon name="radio" size={22} />
        </Link>
        <HeaderLinks />
        {me && (
          <Link to="/settings" className="focus-ring rounded-full" aria-label={label("settings")}>
            <Avatar name={me.name || me.email} size={32} />
          </Link>
        )}
      </div>
    </header>
  );
}

/** Page header used by pages on mobile and desktop. */
export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="px-4 pb-4 pt-2 md:px-6 md:pt-6 lg:pt-2">
      <div className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-title-1">{title}</h1>
        {actions}
      </div>
      {children}
    </header>
  );
}
