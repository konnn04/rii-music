import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { sendFeedback, startDownload, useDiscover, useForYou } from "@/lib/queries";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Empty, ErrorState, SectionHeader } from "@/components/ui/misc";
import { Shelf } from "@/components/Cards";
import { DiscoverRow, ExtArtistCard, RecCard } from "@/components/Recs";
import { PageHeader } from "@/components/layout/AppShell";
import { toast } from "@/components/ui/Toast";
import { t, tsv } from "@/i18n";

export function DiscoverPage() {
  const forYou = useForYou();
  const disc = useDiscover();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);

  const dismissArtist = (artist: string) => {
    setHidden((h) => new Set(h).add(artist.toLowerCase()));
    sendFeedback("artist", artist, -1);
    toast(t("discover.dismissArtistToast", { artist }));
  };

  const tracks = (disc.data?.tracks ?? []).filter((t) => !hidden.has(t.artist.toLowerCase()));
  const artists = (disc.data?.artists ?? []).filter((a) => !hidden.has(a.name.toLowerCase()));
  const provider = disc.data?.provider === "lastfm" ? "Last.fm" : "Deezer";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("common.nav.discover")}>
        <p className="mt-1 text-body-sm text-fg-muted">
          {t("discover.subtitle", { provider })}
        </p>
      </PageHeader>

      <section className="md:px-6">
        <SectionHeader title={t("discover.forYou.title")} sub={t("discover.forYou.sub")} />
        {forYou.isLoading ? (
          <Loading text={t("discover.forYou.loading")} />
        ) : forYou.data?.tracks.length ? (
          <Shelf>
            {forYou.data.tracks.slice(0, 24).map((tr, i) => (
              <RecCard key={tr.id} rec={tr} list={forYou.data!.tracks} index={i} source={{ type: "mix", id: "foryou", name: t("discover.forYou.title") }} />
            ))}
          </Shelf>
        ) : (
          <p className="px-4 text-body-sm text-fg-muted md:px-0">{t("discover.forYou.empty")}</p>
        )}
      </section>

      {disc.isLoading ? (
        <Loading text={t("discover.loading", { provider })} />
      ) : disc.error ? (
        <ErrorState error={disc.error} onRetry={() => disc.refetch()} />
      ) : disc.data?.needHistory ? (
        <Empty icon="radio" title={t("discover.needHistory.title")} action={<Link to="/library" className="focus-ring inline-flex h-11 items-center rounded-control bg-surface-2 px-4 text-label">{t("discover.needHistory.action")}</Link>}>
          {t("discover.needHistory.body")}
        </Empty>
      ) : (
        <>
          {disc.data?.error && (
            <p className="mx-4 flex items-center gap-2 rounded-control bg-surface-1 p-3 text-body-sm text-warning md:mx-6" role="status">
              <Icon name="alert" size={20} /> {tsv(disc.data.error)}
            </p>
          )}
          {artists.length > 0 && (
            <section className="md:px-6">
              <SectionHeader title={t("discover.artists.title")} sub={t("discover.artists.sub")} />
              <Shelf>
                {artists.map((a) => (
                  <ExtArtistCard key={a.name} name={a.name} image={a.image} reason={a.reason} />
                ))}
              </Shelf>
            </section>
          )}
          <section className="md:px-6">
            <SectionHeader
              title={t("discover.tracks.title")}
              sub={t("discover.tracks.sub")}
              action={
                tracks.length > 0 && (
                  <Button
                    size="sm"
                    icon="download"
                    loading={bulk}
                    onClick={async () => {
                      setBulk(true);
                      try {
                        await startDownload(tracks.slice(0, 10).map((tr) => tr.query).join("\n"));
                        toast(t("discover.tracks.bulkToast"));
                      } finally {
                        setBulk(false);
                      }
                    }}
                  >
                    {t("discover.tracks.bulkButton")}
                  </Button>
                )
              }
            />
            {tracks.length === 0 ? (
              <p className="px-4 text-body-sm text-fg-muted md:px-0">{t("discover.tracks.empty")}</p>
            ) : (
              <ul className="flex flex-col px-2 md:px-0">
                {tracks.map((tr) => (
                  <DiscoverRow key={tr.artist + tr.title} t={tr} onDismiss={() => dismissArtist(tr.artist)} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-body-sm text-fg-muted" role="status">
      <Icon name="loader" size={28} />
      {text}
    </div>
  );
}
