import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { engine } from "@/player/engine";
import { usePlayback, usePlayer } from "@/player/store";
import { notify, toast } from "@/components/ui/Toast";
import { t } from "@/i18n";

export type AppMode = "server" | "local" | "client";

type DesktopSetupState = {
  config: {
    mode: string | null;
    serverUrl: string;
    musicDir: string;
    autostart: boolean;
    closeToTray: boolean;
    startMinimized: boolean;
  };
  defaultMusicDir: string;
  lastError: string | null;
  starting: boolean;
};

type TauriGlobal = {
  core?: {
    invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
  autostart?: {
    isEnabled: () => Promise<boolean>;
    enable: () => Promise<void>;
    disable: () => Promise<void>;
  };
  dialog?: {
    open: (options?: {
      directory?: boolean;
      multiple?: boolean;
      title?: string;
      defaultPath?: string;
    }) => Promise<string | string[] | null>;
  };
  notification?: {
    isPermissionGranted: () => Promise<boolean>;
    requestPermission: () => Promise<"granted" | "denied" | "default">;
    sendNotification: (options: string | { title: string; body?: string }) => void;
  };
  opener?: {
    openPath: (path: string, openWith?: string) => Promise<void>;
    revealItemInDir: (path: string | string[]) => Promise<void>;
  };
};

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

type HealthResponse = {
  ok?: boolean;
  version?: string;
  mode?: string;
};

export function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI__;
}

export function useAppMode(): AppMode {
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<HealthResponse>("/api/health"),
    staleTime: 5 * 60_000,
  });
  const m = data?.mode;
  return m === "local" || m === "client" ? m : "server";
}

let initialized = false;

export function initDesktop(): void {
  // Once per launch, a little after start: tell about a new version.
  if (isDesktop()) {
    window.setTimeout(() => {
      checkDesktopUpdate()
        .then((u) => {
          if (u?.version)
            notify({
              icon: "download",
              text: t("settings.desktop.updateAvailable", { version: u.version }),
              duration: 0,
              action: { label: t("settings.desktop.updateNow"), onClick: () => void installDesktopUpdate().catch((e: Error) => toast(e.message, "error")) },
            });
        })
        .catch(() => {});
    }, 15_000);
  }
  if (initialized || !isDesktop()) return;
  initialized = true;

  window.addEventListener("rii:cmd", (ev: Event) => {
    const cmd = (ev as CustomEvent<string>).detail;
    if (cmd === "toggle") engine.toggle();
    else if (cmd === "next") engine.next();
    else if (cmd === "prev") engine.prev();
  });

  let timer: number | null = null;
  let lastKey = "";

  const scheduleNowPlaying = () => {
    const track = usePlayer.getState().current?.track;
    const playing = usePlayback.getState().isPlaying;
    const title = track?.title ?? "";
    const artist = track?.artist ?? "";
    const key = `${title}\0${artist}\0${playing ? 1 : 0}`;
    if (key === lastKey) return;
    lastKey = key;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      window.__TAURI__?.core?.invoke("now_playing", { title, artist, playing }).catch(() => {});
    }, 300);
  };

  usePlayer.subscribe((s, prev) => {
    if (
      s.current?.uid !== prev.current?.uid ||
      s.current?.track.title !== prev.current?.track.title ||
      s.current?.track.artist !== prev.current?.track.artist
    ) {
      scheduleNowPlaying();
    }
  });

  usePlayback.subscribe((s, prev) => {
    if (s.isPlaying !== prev.isPlaying) scheduleNowPlaying();
  });

  scheduleNowPlaying();
}

export type DesktopUpdate = { current: string; version: string | null; notes: string | null };

/** Ask the desktop app whether a newer version is published. */
export async function checkDesktopUpdate(): Promise<DesktopUpdate | null> {
  if (!isDesktop()) return null;
  return (await window.__TAURI__?.core?.invoke("check_update")) as DesktopUpdate;
}

/** Download, install and restart into the new version. */
export async function installDesktopUpdate(): Promise<void> {
  await window.__TAURI__?.core?.invoke("install_update");
}

export async function notifyDesktop(title: string, body: string): Promise<void> {
  const notif = window.__TAURI__?.notification;
  if (!notif) return;
  try {
    let granted = await notif.isPermissionGranted();
    if (!granted) {
      const perm = await notif.requestPermission();
      granted = perm === "granted";
    }
    if (granted) {
      notif.sendNotification({ title, body });
    }
  } catch {
    /* ignore */
  }
}

export async function getDesktopAutostart(): Promise<boolean> {
  const tauri = window.__TAURI__;
  if (!tauri) return false;
  try {
    if (tauri.core) {
      const st = await tauri.core.invoke<DesktopSetupState>("get_setup_state");
      if (typeof st?.config?.autostart === "boolean") return st.config.autostart;
    }
  } catch {
    /* fall back to plugin */
  }
  try {
    if (tauri.autostart) return await tauri.autostart.isEnabled();
  } catch {
    /* ignore */
  }
  return false;
}

export async function setDesktopAutostart(enabled: boolean): Promise<void> {
  await window.__TAURI__?.core?.invoke("set_autostart", { enabled });
}

export async function pickDesktopFolder(title: string, defaultPath?: string): Promise<string | null> {
  const tauri = window.__TAURI__;
  if (!tauri) return null;
  if (tauri.dialog?.open) {
    const picked = await tauri.dialog.open({ directory: true, title, defaultPath });
    if (Array.isArray(picked)) return picked[0] ?? null;
    return picked ?? null;
  }
  if (tauri.core) {
    const picked = await tauri.core.invoke<string | null>("pick_music_dir", {
      defaultPath: defaultPath ?? null,
    });
    return picked ?? null;
  }
  return null;
}

export async function openDesktopPath(path: string): Promise<void> {
  const opener = window.__TAURI__?.opener;
  if (!opener) return;
  if (opener.openPath) {
    await opener.openPath(path);
  } else if (opener.revealItemInDir) {
    await opener.revealItemInDir(path);
  }
}
