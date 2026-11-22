import { useState } from "react";
import { useHistory, useStats } from "@/lib/queries";
import { fmtAgo, fmtMs } from "@/lib/format";
import { usePlayer } from "@/player/store";
import { Cover } from "@/components/ui/Cover";
import { Empty, ErrorState, SectionHeader, Spinner } from "@/components/ui/misc";
import { ArtistCard, Shelf } from "@/components/Cards";
import { PageHeader } from "@/components/layout/AppShell";
import { lang, locale, t, tn } from "@/i18n";

const ranges = [
  [7, t("history.ranges.week")],
  [30, t("history.ranges.month")],
  [365, t("history.ranges.year")],
] as const;

export function HistoryPage() {
  const [days, setDays] = useState<number>(7);
  const stats = useStats(days);
  const history = useHistory();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("common.nav.history")}>
        <div role="tablist" className="mt-4 flex gap-2">
          {ranges.map(([d, label]) => (
            <button
              key={d}
              role="tab"
              aria-selected={days === d}
              onClick={() => setDays(d)}
              className={`focus-ring h-9 rounded-full px-4 text-label ${days === d ? "bg-fg text-canvas" : "bg-surface-2 state-layer"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </PageHeader>

      {stats.isLoading ? (
        <Spinner />
      ) : stats.error || !stats.data ? (
        <ErrorState error={stats.error} onRetry={stats.refetch} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 px-4 md:grid-cols-4 md:px-6">
            <Stat label={t("history.stats.minutes")} value={stats.data.totalMinutes.toLocaleString(locale())} />
            <Stat label={t("history.stats.plays")} value={stats.data.plays.toLocaleString(locale())} />
            <Stat label={t("history.stats.skips")} value={stats.data.skips.toLocaleString(locale())} />
            <Stat label={t("history.stats.libraryCount")} value={stats.data.libraryCount.toLocaleString(locale())} />
          </div>

          <section className="px-4 md:px-6">
            <h2 className="mb-3 text-title-3">{t("history.chart.title")}</h2>
            <BarChart data={stats.data.days} />
          </section>

          <div className="grid gap-8 md:px-6 lg:grid-cols-2">
            <section>
              <SectionHeader title={t("history.topTracks.title")} />
              {stats.data.topTracks.length === 0 ? (
                <p className="px-4 text-body-sm text-fg-muted md:px-0">{t("history.topTracks.empty")}</p>
              ) : (
                <ol className="flex flex-col px-2 md:px-0">
                  {stats.data.topTracks.slice(0, 10).map((tr, i) => (
                    <li key={tr.id}>
                      <button
                        className="focus-ring flex h-14 w-full items-center gap-3 rounded-control px-2 text-left hover:bg-surface-1"
                        onClick={() =>
                          usePlayer.getState().playList(
                            stats.data!.topTracks,
                            i,
                            { type: "mix", id: `top${days}`, name: t("history.topTracks.title") },
                            { shuffle: false },
                          )
                        }
                      >
                        <span className="w-6 text-right text-body-sm text-fg-muted tabular">{i + 1}</span>
                        <Cover trackId={tr.id} hasCover={tr.hasCover} size={40} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body">{tr.title}</span>
                          <span className="block truncate text-body-sm text-fg-muted">{tr.artist}</span>
                        </span>
                        <span className="text-body-sm text-fg-muted tabular">{tn("history.topTracks.plays", tr.plays)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section>
              <SectionHeader title={t("history.topArtists.title")} />
              {stats.data.topArtists.length === 0 ? (
                <p className="px-4 text-body-sm text-fg-muted md:px-0">{t("history.topArtists.empty")}</p>
              ) : (
                <Shelf>
                  {stats.data.topArtists.slice(0, 8).map((a) => (
                    <ArtistCard key={a.name} artist={{ name: a.name, coverTrackId: a.coverTrackId }} />
                  ))}
                </Shelf>
              )}
            </section>
          </div>
        </>
      )}

      <section className="md:px-6">
        <SectionHeader title={t("history.recent.title")} />
        {history.isLoading ? (
          <Spinner />
        ) : !history.data?.length ? (
          <Empty icon="history" title={t("history.recent.empty")} />
        ) : (
          <ul className="flex flex-col px-2 md:px-0">
            {history.data.slice(0, 100).map((h, i) => (
              <li key={i} className="cv-row">
                <button
                  className="focus-ring flex h-14 w-full items-center gap-3 rounded-control px-2 text-left hover:bg-surface-1"
                  onClick={() => usePlayer.getState().playList([h.track], 0, { type: "history", name: t("history.recent.sourceName") })}
                >
                  <Cover trackId={h.track.id} hasCover={h.track.hasCover} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body">{h.track.title}</span>
                    <span className="block truncate text-body-sm text-fg-muted">
                      {h.track.artist} · {fmtAgo(h.startedAt)}
                    </span>
                  </span>
                  <span className="hidden text-caption text-fg-subtle md:inline">
                    {h.action === "skip" ? t("history.action.skipped", { time: fmtMs(h.playedMs) }) : h.action === "repeat" ? t("history.action.repeated") : t("history.action.finished")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card bg-surface-1 p-4">
      <div className="text-title-2 tabular">{value}</div>
      <div className="text-body-sm text-fg-muted">{label}</div>
    </div>
  );
}

function BarChart({ data }: { data: { date: string; minutes: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.minutes));
  const many = data.length > 31;
  // Year view: aggregate by month so bars stay readable.
  const rows = many
    ? Object.values(
        data.reduce<Record<string, { date: string; minutes: number }>>((acc, d) => {
          const k = d.date.slice(0, 7);
          acc[k] = acc[k] ?? { date: k, minutes: 0 };
          acc[k].minutes += d.minutes;
          return acc;
        }, {}),
      )
    : data;
  const m = Math.max(1, ...rows.map((d) => d.minutes));
  const label = (d: string) => {
    if (many) return lang === "vi" ? `T${parseInt(d.slice(5, 7), 10)}` : new Date(d + "-01T00:00:00").toLocaleDateString(locale(), { month: "short" });
    const dt = new Date(d + "T00:00:00");
    return data.length <= 7 ? dt.toLocaleDateString(locale(), { weekday: "short" }) : String(dt.getDate());
  };
  void max;
  return (
    <figure className="rounded-card bg-surface-1 p-4">
      <div className="flex h-40 items-end gap-1" role="img" aria-label={t("history.chart.ariaLabel")}>
        {rows.map((d) => (
          <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end">
            <div
              className="min-h-[2px] rounded-t-[3px] bg-accent transition-[height] duration-slow"
              style={{ height: `${(d.minutes / m) * 100}%`, opacity: d.minutes ? 1 : 0.25 }}
              title={t("history.chart.entry", { date: d.date, minutes: Math.round(d.minutes) })}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1">
        {rows.map((d, i) => (
          <div key={d.date} className="flex-1 truncate text-center text-caption text-fg-subtle">
            {rows.length <= 12 || i % Math.ceil(rows.length / 10) === 0 ? label(d.date) : ""}
          </div>
        ))}
      </div>
      <figcaption className="sr-only">
        {rows.map((d) => t("history.chart.entry", { date: d.date, minutes: Math.round(d.minutes) })).join("; ")}
      </figcaption>
    </figure>
  );
}
