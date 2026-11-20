import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/i18n";

type Credit = {
  name: string;
  roleKey: string;
  url: string;
};

const CREDITS: readonly Credit[] = [
  { name: "YouTube Music", roleKey: "about.roles.ytmusic", url: "https://music.youtube.com" },
  { name: "yt-dlp", roleKey: "about.roles.ytdlp", url: "https://github.com/yt-dlp/yt-dlp" },
  { name: "FFmpeg", roleKey: "about.roles.ffmpeg", url: "https://ffmpeg.org" },
  { name: "LRCLIB", roleKey: "about.roles.lrclib", url: "https://lrclib.net" },
  { name: "Deezer", roleKey: "about.roles.similarArtists", url: "https://www.deezer.com" },
  { name: "Last.fm", roleKey: "about.roles.similarArtists", url: "https://www.last.fm" },
  { name: "MusicBrainz", roleKey: "about.roles.musicbrainz", url: "https://musicbrainz.org" },
  { name: "PostgreSQL", roleKey: "about.roles.postgresql", url: "https://www.postgresql.org" },
  { name: "Go", roleKey: "about.roles.go", url: "https://go.dev" },
  { name: "React", roleKey: "about.roles.react", url: "https://react.dev" },
  { name: "Vite", roleKey: "about.roles.vite", url: "https://vite.dev" },
  { name: "TanStack Router & Query", roleKey: "about.roles.tanstack", url: "https://tanstack.com" },
  { name: "Zustand", roleKey: "about.roles.zustand", url: "https://zustand.docs.pmnd.rs" },
  { name: "Tailwind CSS", roleKey: "about.roles.tailwind", url: "https://tailwindcss.com" },
  { name: "Radix UI", roleKey: "about.roles.radix", url: "https://www.radix-ui.com" },
  { name: "dnd-kit", roleKey: "about.roles.dndkit", url: "https://dndkit.com" },
  { name: "Be Vietnam Pro", roleKey: "about.roles.font", url: "https://fonts.google.com/specimen/Be+Vietnam+Pro" },
];

/** Settings card showing app version, credits, and usage note. */
export function AboutCard() {
  const brand = useBranding();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ version: string }>("/api/health"),
    staleTime: 5 * 60_000,
  });

  const rawVersion = health.data?.version;
  const versionLabel = rawVersion ? (rawVersion === "dev" ? "dev" : t("about.version", { version: rawVersion })) : null;

  return (
    <section className="rounded-card bg-surface-1 px-4 py-2">
      <h2 className="flex h-12 items-center gap-2 text-title-3">
        <Icon name="info" size={20} className="text-accent" />
        {t("about.title")}
      </h2>
      <div className="flex flex-col divide-y divide-line">
        <div className="flex flex-wrap items-baseline justify-between gap-2 py-4">
          <div className="text-body font-medium">{brand.name}</div>
          {versionLabel && <span className="font-mono text-caption text-fg-muted">{versionLabel}</span>}
        </div>

        <div className="flex flex-col gap-3 py-4">
          <div className="flex items-center gap-2 text-label text-fg-muted">
            <Icon name="code" size={16} />
            {t("about.creditsTitle")}
          </div>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
            {CREDITS.map((c) => (
              <li key={c.name} className="flex flex-col text-body-sm">
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring self-start rounded-sm font-medium text-fg hover:text-accent hover:underline"
                >
                  {c.name}
                </a>
                <span className="text-caption text-fg-muted">{t(c.roleKey)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2 py-4">
          <div className="flex items-center gap-2 text-body-sm text-fg">
            <Icon name="heart" size={16} className="text-accent" />
            <span>{t("about.madeBy", { name: "Nguyen Thanh Trieu" })}</span>
          </div>
          <p className="text-caption text-fg-muted">{t("about.disclaimer")}</p>
        </div>
      </div>
    </section>
  );
}
