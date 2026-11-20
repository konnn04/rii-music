// Is the server reachable? Offline = the browser has no connection, or the
// server stopped answering (e.g. home server down while on mobile data).
// While offline only songs stored on this device play (lib/offline.ts).
import { create } from "zustand";

export const useNet = create<{ serverDown: boolean }>(() => ({ serverDown: false }));

export function isOffline(): boolean {
  return !navigator.onLine || useNet.getState().serverDown;
}

let timer: number | null = null;

/** Ask the server directly (the service worker doesn't answer /api/health). */
export async function probeServer(): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const r = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** A request failed: check, and if the server is down keep checking until it is back. */
export async function noteNetworkFailure(): Promise<boolean> {
  const up = await probeServer();
  if (up) return false;
  useNet.setState({ serverDown: true });
  if (timer == null) {
    timer = window.setInterval(async () => {
      if (await probeServer()) {
        useNet.setState({ serverDown: false });
        if (timer != null) clearInterval(timer);
        timer = null;
      }
    }, 20_000);
  }
  return true;
}

window.addEventListener("online", () => {
  void probeServer().then((up) => up && useNet.setState({ serverDown: false }));
});
