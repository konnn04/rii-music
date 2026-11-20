import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Album,
  type Artist,
  type Genre,
  type HistoryItem,
  type Home,
  type Job,
  type Lyrics,
  type Playlist,
  type Rule,
  type Settings,
  type Stats,
  type Track,
  type WebResult,
  type WebKind,
  type DiscoverArtist,
  type DiscoverTrack,
  type Me,
  type RecTrack,
  type SimilarArtist,
} from "./api";
import { toast } from "@/components/ui/Toast";
import { usePlayer } from "@/player/store";
import { t, tsv } from "@/i18n";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (n, err: any) => err?.status !== 401 && err?.status !== 404 && n < 2, refetchOnWindowFocus: false },
    mutations: { onError: (e: any) => toast(e?.message ?? t("common.error"), "error") },
  },
});

export type TrackSort = "added" | "title" | "artist" | "plays";

export const useTracks = (sort: TrackSort = "added") =>
  useQuery({ queryKey: ["tracks", sort], queryFn: () => api<Track[]>(`/api/tracks?sort=${sort}`) });
export const useArtists = () => useQuery({ queryKey: ["artists"], queryFn: () => api<Artist[]>("/api/artists") });
export const useAlbums = () => useQuery({ queryKey: ["albums"], queryFn: () => api<Album[]>("/api/albums") });
export const useGenres = () => useQuery({ queryKey: ["genres"], queryFn: () => api<Genre[]>("/api/genres"), staleTime: 5 * 60_000 });
export const useArtist = (name: string) =>
  useQuery({
    queryKey: ["artist", name],
    queryFn: () => api<{ name: string; tracks: Track[]; albums: Album[]; others: Artist[] }>(`/api/artist?name=${encodeURIComponent(name)}`),
  });
export const useAlbum = (artist: string, name: string) =>
  useQuery({
    queryKey: ["album", artist, name],
    queryFn: () =>
      api<{ name: string; artist: string; tracks: Track[] }>(`/api/album?artist=${encodeURIComponent(artist)}&name=${encodeURIComponent(name)}`),
  });
export const usePlaylists = () => useQuery({ queryKey: ["playlists"], queryFn: () => api<Playlist[]>("/api/playlists") });
export const usePlaylist = (id: string) =>
  useQuery({ queryKey: ["playlist", id], queryFn: () => api<{ playlist: Playlist; tracks: Track[] }>(`/api/playlists/${id}`) });
export const useHome = () =>
  useQuery({ queryKey: ["home"], queryFn: () => api<Home>(`/api/home?hour=${new Date().getHours()}`) });
export const useJobs = () =>
  useQuery({ queryKey: ["jobs"], queryFn: () => api<{ jobs: Job[]; ytdlpReady: boolean; ytdlpError: string }>("/api/downloads") });
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("/api/settings"), staleTime: Infinity });
export const useStats = (days: number) =>
  useQuery({ queryKey: ["stats", days], queryFn: () => api<Stats>(`/api/stats?days=${days}&tz=${new Date().getTimezoneOffset()}`) });
export const useHistory = () => useQuery({ queryKey: ["history"], queryFn: () => api<HistoryItem[]>("/api/history?limit=200") });
export const useLyrics = (id: string | undefined) =>
  useQuery({ queryKey: ["lyrics", id], queryFn: () => api<Lyrics>(`/api/tracks/${id}/lyrics`), enabled: !!id, staleTime: Infinity, retry: 1 });

export const useDiscover = () =>
  useQuery({
    queryKey: ["discover"],
    queryFn: () => api<{ artists: DiscoverArtist[]; tracks: DiscoverTrack[]; provider: string; needHistory?: boolean; error?: string }>("/api/recs/discover"),
    staleTime: 10 * 60_000,
    retry: 0,
  });
export const useForYou = () => useQuery({ queryKey: ["foryou"], queryFn: () => api<{ tracks: RecTrack[] }>("/api/recs/foryou"), staleTime: 5 * 60_000 });
export const useSimilarArtists = (name: string) =>
  useQuery({
    queryKey: ["artistSimilar", name],
    queryFn: () => api<{ artists: SimilarArtist[]; provider: string }>(`/api/artist/similar?name=${encodeURIComponent(name)}`),
    staleTime: 60 * 60_000,
    retry: 0,
  });
export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me"), staleTime: 60_000 });

/** "Ít gợi ý kiểu này" (value -1) or undo (0). */
export function sendFeedback(kind: "artist" | "track", key: string, value: -1 | 0 | 1) {
  return api("/api/feedback", { method: "POST", json: { kind, key, value } }).then(() => {
    for (const k of ["home", "foryou", "discover"]) queryClient.invalidateQueries({ queryKey: [k] });
  });
}

export const useLibrarySearch = (q: string) =>
  useQuery({
    queryKey: ["search", "library", q],
    queryFn: () =>
      api<{ tracks: Track[]; artists: Artist[]; albums: Album[]; playlists: Playlist[] }>(`/api/search?scope=library&q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });
export const useWebSearch = (q: string, enabled: boolean, kind: WebKind = "songs") =>
  useQuery({
    queryKey: ["search", "web", q, kind],
    queryFn: () => api<{ results: WebResult[]; source: "ytmusic" | "youtube" }>(`/api/search?scope=web&kind=${kind}&q=${encodeURIComponent(q)}`),
    enabled: enabled && q.trim().length > 0,
    staleTime: 5 * 60_000,
    retry: 0,
  });

/** Library-wide data changed (download finished, edit, like). */
export function invalidateLibrary() {
  for (const k of ["tracks", "artists", "albums", "artist", "album", "playlists", "playlist", "home", "search", "foryou", "discover"]) {
    queryClient.invalidateQueries({ queryKey: [k] });
  }
}

/** Patch a track everywhere it is cached, for instant feedback. */
export function patchTrackInCache(id: string, patch: Partial<Track>) {
  const fix = (t: Track) => (t.id === id ? { ...t, ...patch } : t);
  queryClient.setQueriesData({ queryKey: ["tracks"] }, (d: Track[] | undefined) => d?.map(fix));
  queryClient.setQueriesData({ queryKey: ["playlist"] }, (d: any) => (d?.tracks ? { ...d, tracks: d.tracks.map(fix) } : d));
  queryClient.setQueriesData({ queryKey: ["album"] }, (d: any) => (d?.tracks ? { ...d, tracks: d.tracks.map(fix) } : d));
  queryClient.setQueriesData({ queryKey: ["artist"] }, (d: any) => (d?.tracks ? { ...d, tracks: d.tracks.map(fix) } : d));
}

export function useToggleLike() {
  return useMutation({
    mutationFn: ({ id, liked }: { id: string; liked: boolean }) =>
      api(`/api/likes/${id}`, { method: liked ? "PUT" : "DELETE" }),
    onMutate: ({ id, liked }) => {
      patchTrackInCache(id, { liked });
      usePlayer.getState().patchTrack(id, { liked });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["playlists"] });
      queryClient.invalidateQueries({ queryKey: ["playlist", "liked"] });
    },
  });
}

export function useAddToPlaylist() {
  return useMutation({
    mutationFn: ({ playlistId, trackIds }: { playlistId: string; trackIds: string[] }) =>
      api(`/api/playlists/${playlistId}/items`, { method: "POST", json: { trackIds } }),
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: ["playlists"] });
      queryClient.invalidateQueries({ queryKey: ["playlist", v.playlistId] });
      toast(v.trackIds.length > 1 ? t("ui.toast.addedManyToPlaylist", { count: v.trackIds.length }) : t("ui.toast.addedToPlaylist"));
    },
  });
}

export function useCreatePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; rule?: Rule; trackIds?: string[] }) => api<Playlist>("/api/playlists", { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["playlists"] }),
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: Partial<Settings>) => api<Settings>("/api/settings", { method: "PUT", json: s }),
    onMutate: (s) => {
      qc.setQueryData(["settings"], (old: Settings | undefined) => (old ? { ...old, ...s } : old));
    },
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });
}

export function startDownload(input: string) {
  return api<{ jobs: Job[]; errors: string[] }>("/api/downloads", { method: "POST", json: { input } }).then((r) => {
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    if (r.errors?.length) toast(r.errors.map(tsv).join("\n"), "error");
    return r;
  });
}
