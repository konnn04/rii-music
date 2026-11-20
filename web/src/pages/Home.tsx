import { Link } from "@tanstack/react-router";
import { useHome } from "@/lib/queries";
import { Icon } from "@/components/ui/Icon";
import { Empty, ErrorState, SectionHeader, Skeleton } from "@/components/ui/misc";
import { ArtistCard, MixCard, Shelf, TrackCard } from "@/components/Cards";
import { DiscoverLink, ExtArtistCard, RecCard } from "@/components/Recs";
import { PageHeader } from "@/components/layout/AppShell";
import { Mascot } from "@/components/Mascot";
import type { Source } from "@/player/store";
import { t, tsv } from "@/i18n";

function greeting() {
  const h = new Date().getHours();
  return t(`home.greeting.${h < 5 ? "night" : h < 11 ? "morning" : h < 13 ? "noon" : h < 18 ? "afternoon" : "evening"}`);
}

export function HomePage() {
  const { data, isLoading, error, refetch } = useHome();

  const header = (
    <PageHeader
      title={greeting()}
      actions={
        <div className="flex lg:hidden">
          <Link to="/history" aria-label={t("common.nav.history")} className="focus-ring state-layer flex size-11 items-center justify-center rounded-full text-fg-muted">
            <Icon name="history" />
          </Link>
        </div>
      }
    />
  );

  if (isLoading)
    return (
      <div>
        {header}
        <div className="flex gap-4 overflow-hidden px-4 md:px-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square w-[140px] shrink-0 rounded-card md:w-44" />
          ))}
        </div>
      </div>
    );
  if (error || !data)
    return (
      <div>
        {header}
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );

  if (data.libraryCount === 0) {
    return (
      <div className="flex flex-col gap-6 md:px-6">
        <div className="md:-mx-6">{header}</div>
        <Mascot />
        <Empty
          icon="search"
          title={t("home.empty.title")}
          action={
            <Link to="/search" className="focus-ring inline-flex h-11 items-center gap-2 rounded-control bg-accent px-4 text-label text-fg-on-accent">
              <Icon name="search" size={20} />
              {t("home.empty.action")}
            </Link>
          }
        >
          {t("home.empty.body")}
        </Empty>
      </div>
    );
  }

  const src = (type: Source["type"], name: string, id?: string): Source => ({ type, name, id });

  return (
    <div className="flex flex-col gap-8 pb-4 md:px-6">
      <div className="-mx-0 md:-mx-6">{header}</div>
      <Mascot />

      {data.continue.length > 0 && (
        <section>
          <SectionHeader title={t("home.continue")} />
          <Shelf>
            {data.continue.slice(0, 12).map((tr, i) => (
              <TrackCard key={tr.id} track={tr} tracks={data.continue} index={i} source={src("history", t("home.continue"), "continue")} />
            ))}
          </Shelf>
        </section>
      )}

      {data.mixes.length > 0 && (
        <section>
          <SectionHeader title={t("home.mixes.title")} sub={t("home.mixes.sub")} />
          <Shelf>
            {data.mixes.map((m, i) => (
              <MixCard key={m.id} mix={m} i={i} />
            ))}
          </Shelf>
        </section>
      )}

      {data.forYou.length > 0 && (
        <section>
          <SectionHeader title={t("home.forYou.title")} sub={t("home.forYou.sub")} action={<DiscoverLink />} />
          <Shelf>
            {data.forYou.slice(0, 12).map((tr, i) => (
              <RecCard key={tr.id} rec={tr} list={data.forYou} index={i} source={src("mix", t("home.forYou.title"), "foryou")} />
            ))}
          </Shelf>
        </section>
      )}

      {data.similarArtists && (
        <section>
          <SectionHeader title={t("home.similar.title", { name: data.similarArtists.seed })} sub={t("home.similar.sub")} action={<DiscoverLink />} />
          <Shelf>
            {data.similarArtists.artists.map((a) => (
              <ExtArtistCard key={a.name} name={a.name} image={a.image} inLibrary={a.inLibrary} />
            ))}
          </Shelf>
        </section>
      )}

      {data.topArtists.length > 0 && (
        <section>
          <SectionHeader title={t("home.topArtists")} />
          <Shelf>
            {data.topArtists.slice(0, 8).map((a) => (
              <ArtistCard key={a.name} artist={a} />
            ))}
          </Shelf>
        </section>
      )}

      {data.timeOfDay.tracks.length >= 3 && (
        <section>
          <SectionHeader title={tsv(data.timeOfDay.label)} />
          <Shelf>
            {data.timeOfDay.tracks.map((tr, i) => (
              <TrackCard key={tr.id} track={tr} tracks={data.timeOfDay.tracks} index={i} source={src("mix", data.timeOfDay.label, "tod")} />
            ))}
          </Shelf>
        </section>
      )}

      <section>
        <SectionHeader
          title={t("home.recent")}
          action={
            <Link to="/library" search={{ tab: "songs" }} className="focus-ring rounded-xs text-label text-fg-muted hover:text-fg hover:underline">
              {t("common.showAll")}
            </Link>
          }
        />
        <Shelf>
          {data.recentlyAdded.map((tr, i) => (
            <TrackCard key={tr.id} track={tr} tracks={data.recentlyAdded} index={i} source={src("library", t("home.recent"), "recent")} />
          ))}
        </Shelf>
      </section>
    </div>
  );
}
