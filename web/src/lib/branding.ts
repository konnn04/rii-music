import { useQuery } from "@tanstack/react-query";
import { api, type Branding } from "./api";

declare global {
  interface Window {
    __RII_BRAND__?: { name: string; description: string; logoUrl: string };
  }
}

const initial: Branding = {
  name: window.__RII_BRAND__?.name ?? "RiiMusic",
  description: window.__RII_BRAND__?.description ?? "",
  logoUrl: window.__RII_BRAND__?.logoUrl ?? "/icon.png",
  customLogo: false,
};

/** Name, description and logo of this server (set by an admin; works signed out too). */
export function useBranding(): Branding {
  const q = useQuery({ queryKey: ["branding"], queryFn: () => api<Branding>("/api/branding"), staleTime: 5 * 60_000, initialData: initial, initialDataUpdatedAt: 0 });
  return q.data ?? initial;
}
