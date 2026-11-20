import { useState } from "react";
import { api, type Job, type Track } from "@/lib/api";
import { queryClient, startDownload, useJobs } from "@/lib/queries";
import { fmtAgo } from "@/lib/format";
import { usePlayer } from "@/player/store";
import { Button, IconButton } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Empty, ErrorState, Spinner } from "@/components/ui/misc";
import { Cover } from "@/components/ui/Cover";
import { PageHeader } from "@/components/layout/AppShell";
import { t, tsv } from "@/i18n";

const statusText: Record<Job["status"], string> = {
  queued: t("downloads.status.queued"),
  downloading: t("downloads.status.downloading"),
  processing: t("downloads.status.processing"),
  done: t("common.done"),
  error: t("downloads.status.error"),
  skipped: t("downloads.status.skipped"),
};

export function DownloadsPage() {
  const { data, isLoading, error, refetch } = useJobs();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setBusy(true);
    try {
      const r = await startDownload(input);
      if (r.jobs.length) setInput("");
    } catch {
      /* toast from mutation default handler is not used here */
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setInput((v) => (v ? v + "\n" : "") + t.trim());
    } catch {
      document.getElementById("dl-input")?.focus();
    }
  };

  const jobs = data?.jobs ?? [];
  const active = jobs.filter((j) => ["queued", "downloading", "processing"].includes(j.status));
  const finished = jobs.filter((j) => !["queued", "downloading", "processing"].includes(j.status));
  const hasErrors = finished.some((j) => j.status === "error");

  return (
    <div>
      <PageHeader title={t("common.nav.downloads")} />
      <div className="grid gap-6 px-4 md:px-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="flex flex-col gap-3 lg:sticky lg:top-[calc(var(--spacing-topbar)+8px)] lg:self-start">
          <form onSubmit={submit} className="flex flex-col gap-3 rounded-card bg-surface-1 p-4">
            <label htmlFor="dl-input" className="text-label">
              {t("downloads.form.label")}
            </label>
            <textarea
              id="dl-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
              }}
              rows={3}
              placeholder={t("downloads.form.placeholder")}
              className="input min-h-24 resize-y"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-caption text-fg-subtle">{t("downloads.form.hint")}</p>
            <div className="flex gap-2">
              <Button type="button" icon="clipboard" onClick={paste}>
                {t("downloads.form.paste")}
              </Button>
              <Button type="submit" variant="primary" icon="download" loading={busy} disabled={!input.trim()} className="flex-1">
                {t("common.download")}
              </Button>
            </div>
          </form>
          {data && !data.ytdlpReady && (
            <div className="flex gap-3 rounded-card bg-surface-1 p-4 text-body-sm" role="status">
              <Icon name={data.ytdlpError ? "alert" : "loader"} className={data.ytdlpError ? "text-warning" : "text-fg-muted"} />
              <div>
                {data.ytdlpError ? (
                  <>
                    <p className="font-medium">{t("downloads.ytdlp.notReady")}</p>
                    <p className="text-fg-muted">{t("downloads.ytdlp.errorDetail", { error: tsv(data.ytdlpError) })}</p>
                  </>
                ) : (
                  <p className="text-fg-muted">{t("downloads.ytdlp.preparing")}</p>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-6">
          {isLoading ? (
            <Spinner />
          ) : error ? (
            <ErrorState error={error} onRetry={refetch} />
          ) : jobs.length === 0 ? (
            <Empty icon="download" title={t("downloads.empty.title")}>
              {t("downloads.empty.body")}
            </Empty>
          ) : (
            <>
              {active.length > 0 && (
                <div>
                  <h2 className="mb-2 text-title-3">{t("downloads.section.active", { count: active.length })}</h2>
                  <ul className="flex flex-col gap-2">
                    {active.map((j) => (
                      <JobRow key={j.id} j={j} />
                    ))}
                  </ul>
                </div>
              )}
              {finished.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="flex-1 text-title-3">{t("downloads.section.recent")}</h2>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api(`/api/downloads${hasErrors ? "?errors=1" : ""}`, { method: "DELETE" });
                        queryClient.invalidateQueries({ queryKey: ["jobs"] });
                      }}
                    >
                      {t("downloads.clearList")}
                    </Button>
                  </div>
                  <ul className="flex flex-col gap-2">
                    {finished.map((j) => (
                      <JobRow key={j.id} j={j} />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function JobRow({ j }: { j: Job }) {
  const pct = Math.round(j.progress * 100);
  const running = j.status === "downloading" || j.status === "processing";
  const playTrack = async () => {
    const track = await api<Track>(`/api/tracks/${j.trackId}`);
    usePlayer.getState().playList([track], 0, { type: "library", name: track.title });
  };
  const remove = async () => {
    await api(`/api/downloads/${j.id}`, { method: "DELETE" });
    queryClient.setQueryData(["jobs"], (d: { jobs: Job[] } | undefined) => (d ? { ...d, jobs: d.jobs.filter((x) => x.id !== j.id) } : d));
  };
  const retry = async () => {
    await api(`/api/downloads/${j.id}/retry`, { method: "POST" });
  };
  const icon = j.status === "error" ? "alert" : j.status === "done" || j.status === "skipped" ? "check" : running ? "loader" : "download";
  const color = j.status === "error" ? "text-danger" : j.status === "done" ? "text-success" : "text-fg-muted";
  const displayTitle = j.title ? tsv(j.title) : j.url.startsWith("ytsearch1:") ? t("downloads.job.searchPrefix", { query: j.url.slice("ytsearch1:".length) }) : j.url;
  const stageText = j.stage ? tsv(j.stage) : undefined;
  return (
    <li className="flex items-start gap-3 rounded-card bg-surface-1 p-3">
      {j.trackId && (j.status === "done" || j.status === "skipped") ? (
        <button className="focus-ring rounded-xs" onClick={playTrack} aria-label={t("downloads.job.play", { title: displayTitle })}>
          <Cover trackId={j.trackId} size={48} />
        </button>
      ) : (
        <span className={`flex size-12 shrink-0 items-center justify-center rounded-xs bg-surface-2 ${color}`}>
          <Icon name={icon} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 break-words text-label">
          {j.origin && j.origin !== "user" && (
            <span className="mr-2 inline-block rounded-xs bg-surface-3 px-1.5 align-[1px] text-caption text-fg-muted">
              {j.origin === "auto" ? t("downloads.job.originAuto") : t("downloads.job.originAutoplay")}
            </span>
          )}
          {displayTitle}
        </div>
        <div className={`mt-0.5 flex items-center gap-2 text-caption ${color}`}>
          <span>
            {running && stageText ? stageText : statusText[j.status]}
            {running && pct > 0 && ` · ${pct}%`}
          </span>
          <span className="text-fg-subtle">· {fmtAgo(j.updatedAt)}</span>
        </div>
        {running && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-4" role="progressbar" aria-valuenow={pct > 0 ? pct : undefined} aria-valuetext={stageText} aria-valuemin={0} aria-valuemax={100} aria-label={t("downloads.job.progress")}>
            {pct > 0 ? (
              <div className="h-full rounded-full bg-accent transition-[width] duration-base" style={{ width: `${pct}%` }} />
            ) : (
              <div className="h-full w-1/3 rounded-full bg-accent animate-[indeterminate_1.2s_ease-in-out_infinite]" />
            )}
          </div>
        )}
        {j.status === "error" && <p className="mt-1 break-words text-caption text-fg-muted">{tsv(j.error)}</p>}
      </div>
      <div className="flex shrink-0">
        {j.status === "error" && <IconButton icon="retry" label={t("common.retry")} onClick={retry} size={20} />}
        <IconButton icon={running || j.status === "queued" ? "close" : "trash"} label={running || j.status === "queued" ? t("common.cancel") : t("downloads.job.removeFromList")} onClick={remove} size={20} />
      </div>
    </li>
  );
}
