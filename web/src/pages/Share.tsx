import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Track } from "@/lib/api";
import { queryClient } from "@/lib/queries";
import { useBranding } from "@/lib/branding";
import { fmtMs } from "@/lib/format";
import { usePlayer } from "@/player/store";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Login } from "./Login";
import { t } from "@/i18n";

type ShareInfo = {
  track: { id: string; title: string; artist: string; album: string; durationMs: number; hasCover: boolean };
  access: "preview" | "add" | "full";
  previewSec: number;
  site: string;
};

/** /s/<token>: a shared song. Anyone hears a 30-second preview; signed-in users add it and play it in full. */
export function SharePage({ token }: { token: string }) {
  const brand = useBranding();
  const info = useQuery({ queryKey: ["share", token], queryFn: () => api<ShareInfo>(`/api/share/${token}`), retry: 0 });
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);

  useEffect(() => {
    document.title = info.data ? `${info.data.track.title} — ${brand.name}` : brand.name;
  }, [info.data, brand.name]);

  if (info.isLoading)
    return (
      <Center>
        <Icon name="loader" size={28} />
      </Center>
    );
  if (info.error || !info.data)
    return (
      <Center>
        <Icon name="alert" size={36} className="text-fg-muted" />
        <p className="text-body text-fg-muted">{(info.error as Error)?.message ?? t("share.invalid")}</p>
        <a className="text-label text-accent hover:underline" href="/">
          {t("share.openApp", { name: brand.name })}
        </a>
      </Center>
    );
  if (login)
    return (
      <Login
        onDone={() => {
          setLogin(false);
          queryClient.invalidateQueries();
        }}
      />
    );

  const d = info.data;
  const cover = d.track.hasCover ? `/api/share/${token}/cover` : brand.logoUrl;

  const togglePreview = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const playFull = async () => {
    setBusy(true);
    try {
      const tr = d.access === "add" ? await api<Track>(`/api/share/${token}/add`, { method: "POST" }) : await api<Track>(`/api/tracks/${d.track.id}`);
      audio.current?.pause();
      usePlayer.getState().playList([tr], 0, { type: "search", name: tr.title });
      location.href = "/";
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-canvas px-6 py-10 pt-safe pb-safe">
      <img src={cover} alt="" aria-hidden className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-30 blur-3xl" />
      <div className="relative flex w-full max-w-sm flex-col items-center gap-5 rounded-sheet bg-surface-1/90 p-6 text-center shadow-sheet backdrop-blur md:p-8">
        <a href="/" className="flex items-center gap-2 text-label text-fg-muted hover:text-fg">
          <img src={brand.logoUrl} alt="" className="size-6 rounded-xs object-contain" />
          {brand.name}
        </a>
        <img src={cover} alt="" className="aspect-square w-full max-w-64 rounded-card object-cover shadow-sheet" />
        <div className="min-w-0">
          <h1 className="text-title-2">{d.track.title}</h1>
          <p className="text-body text-fg-muted">
            {d.track.artist}
            {d.track.album ? ` · ${d.track.album}` : ""} · {fmtMs(d.track.durationMs)}
          </p>
        </div>

        {d.access === "preview" ? (
          <>
            <audio
              ref={audio}
              src={`/api/share/${token}/preview`}
              preload="none"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
            />
            <div className="flex w-full items-center gap-3">
              <button
                onClick={togglePreview}
                className="focus-ring flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-fg-on-accent"
                aria-label={playing ? t("common.pause") : t("share.playPreview")}
              >
                <Icon name={playing ? "pause" : "play"} size={26} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.min(100, (pos / d.previewSec) * 100)}%` }} />
                </div>
                <p className="mt-1.5 text-left text-caption text-fg-muted">{t("share.previewNote", { n: d.previewSec })}</p>
              </div>
            </div>
            <Button variant="primary" className="w-full" icon="logout" onClick={() => setLogin(true)}>
              {t("share.signIn")}
            </Button>
          </>
        ) : (
          <Button variant="primary" className="w-full" icon="play" loading={busy} onClick={playFull}>
            {d.access === "add" ? t("share.addAndPlay") : t("share.play")}
          </Button>
        )}
      </div>
    </main>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">{children}</main>;
}
