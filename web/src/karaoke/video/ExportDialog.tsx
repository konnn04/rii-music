import { useEffect, useMemo, useRef, useState } from "react";
import { parseLRC } from "@/components/layout/LyricsView";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/i18n";
import { fmtBytes } from "@/lib/format";
import { useLyrics } from "@/lib/queries";
import { usePlayer } from "@/player/store";
import { findCachedInstrumental, type AudioChoice } from "./audio";
import type { Resolution } from "./canvas";
import { renderKaraokeVideo, type RenderProgress, type RenderResult } from "./render";

type ExportStatus = "idle" | "rendering" | "done" | "error";

const RESOLUTION_OPTIONS: Resolution[] = ["720p", "1080p"];

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const track = usePlayer((s) => s.current?.track ?? null);
  const { data: lyrics } = useLyrics(track?.id);

  const lines = useMemo(() => (lyrics?.synced ? parseLRC(lyrics.synced) : []), [lyrics?.synced]);
  const hasSynced = lines.length > 0;

  const [resolution, setResolution] = useState<Resolution>("720p");
  const [hasAi, setHasAi] = useState(false);
  const [audioChoice, setAudioChoice] = useState<AudioChoice>("quick");
  const [showLyrics, setShowLyrics] = useState(true);

  const [status, setStatus] = useState<ExportStatus>("idle");
  const [progress, setProgress] = useState<RenderProgress>({ phase: "prepare", frame: 0, totalFrames: 0 });
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [result, setResult] = useState<RenderResult | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const clearBlobUrl = () => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setBlobUrl(null);
  };

  // Detect cached AI instrumental whenever the dialog opens or track changes
  useEffect(() => {
    if (!open || !track) return;
    let alive = true;
    void findCachedInstrumental(track.id).then((key) => {
      if (!alive) return;
      const found = !!key;
      setHasAi(found);
      setAudioChoice(found ? "ai" : "quick");
    });
    return () => {
      alive = false;
    };
  }, [open, track?.id]);

  // Reset export state when switching tracks
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearBlobUrl();
    setResult(null);
    setStatus("idle");
    setErrorMsg("");
    setProgress({ phase: "prepare", frame: 0, totalFrames: 0 });
  }, [track?.id]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const handleCancelRender = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    setProgress({ phase: "prepare", frame: 0, totalFrames: 0 });
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && status === "rendering") {
      handleCancelRender();
    }
    onOpenChange(next);
  };

  const handleStart = async () => {
    if (!track || status === "rendering") return;
    clearBlobUrl();
    setResult(null);
    setErrorMsg("");
    setStatus("rendering");
    setProgress({ phase: "prepare", frame: 0, totalFrames: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const effectiveAudio: AudioChoice = audioChoice === "ai" && !hasAi ? "quick" : audioChoice;
      const res = await renderKaraokeVideo({
        track,
        resolution,
        audioChoice: effectiveAudio,
        showLyrics: hasSynced && showLyrics,
        lines,
        offsetMs: lyrics?.offsetMs ?? 0,
        signal: controller.signal,
        onProgress: setProgress,
      });

      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(res.blob);
      blobUrlRef.current = url;
      setBlobUrl(url);
      setResult(res);
      setStatus("done");
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        setStatus("idle");
        return;
      }
      setErrorMsg(err instanceof Error && err.message ? err.message : t("karaokeVideo.error"));
      setStatus("error");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  const handleDownload = () => {
    if (!blobUrl || !result) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const audioOptions: AudioChoice[] = hasAi ? ["ai", "quick", "original"] : ["quick", "original"];
  const pct =
    progress.phase === "finalize"
      ? 100
      : progress.totalFrames > 0
        ? Math.min(100, Math.round((progress.frame / progress.totalFrames) * 100))
        : 0;

  const isRendering = status === "rendering";

  const footer =
    status === "rendering" ? (
      <Button variant="danger" onClick={handleCancelRender}>
        {t("common.cancel")}
      </Button>
    ) : status === "done" && result && blobUrl ? (
      <>
        <Button
          variant="ghost"
          onClick={() => {
            clearBlobUrl();
            setResult(null);
            setStatus("idle");
          }}
        >
          {t("karaokeVideo.exportAgain")}
        </Button>
        <Button variant="primary" icon="download" onClick={handleDownload}>
          {t("karaokeVideo.download")}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={() => handleOpenChange(false)}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" icon="download" disabled={!track} onClick={() => void handleStart()}>
          {t("karaokeVideo.start")}
        </Button>
      </>
    );

  return (
    <Dialog
      top
      open={open}
      onOpenChange={handleOpenChange}
      title={t("karaokeVideo.title")}
      description={track ? `${track.title}${track.artist ? ` — ${track.artist}` : ""}` : undefined}
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        {/* Resolution */}
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-fg-muted">{t("karaokeVideo.resolution")}</span>
          <div role="radiogroup" aria-label={t("karaokeVideo.resolution")} className="grid grid-cols-2 gap-2">
            {RESOLUTION_OPTIONS.map((res) => {
              const active = resolution === res;
              return (
                <button
                  key={res}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isRendering}
                  onClick={() => setResolution(res)}
                  className={`focus-ring flex items-center justify-center gap-2 rounded-control border px-3 py-2 text-label transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50 ${
                    active ? "border-accent bg-accent/10 text-fg" : "border-line text-fg-muted hover:bg-surface-4 hover:text-fg"
                  }`}
                >
                  <span className={`size-3 rounded-full border-2 ${active ? "border-accent bg-accent" : "border-fg-subtle"}`} />
                  <span>{res}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Audio source */}
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-fg-muted">{t("karaokeVideo.audio")}</span>
          <div role="radiogroup" aria-label={t("karaokeVideo.audio")} className="flex flex-col gap-2">
            {audioOptions.map((opt) => {
              const active = audioChoice === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isRendering}
                  onClick={() => setAudioChoice(opt)}
                  className={`focus-ring flex items-center gap-3 rounded-control border px-3 py-2.5 text-left text-label transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50 ${
                    active ? "border-accent bg-accent/10 text-fg" : "border-line text-fg-muted hover:bg-surface-4 hover:text-fg"
                  }`}
                >
                  <span className={`size-3.5 shrink-0 rounded-full border-2 ${active ? "border-accent bg-accent" : "border-fg-subtle"}`} />
                  <span>{t(`karaokeVideo.audioOptions.${opt}`)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Lyrics toggle */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3 rounded-control border border-line px-3 py-2.5">
            <span className="text-label text-fg">{t("karaokeVideo.lyrics")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={hasSynced && showLyrics}
              aria-label={t("karaokeVideo.lyrics")}
              disabled={isRendering || !hasSynced}
              onClick={() => setShowLyrics((v) => !v)}
              className={`focus-ring relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-fast disabled:pointer-events-none disabled:opacity-40 ${
                hasSynced && showLyrics ? "bg-accent" : "bg-surface-4"
              }`}
            >
              <span
                className={`inline-block size-4 rounded-full bg-white shadow transition-transform duration-fast ${
                  hasSynced && showLyrics ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          {!hasSynced && <p className="text-caption text-fg-muted">{t("karaokeVideo.noSyncedHint")}</p>}
        </div>

        {/* Device rendering note */}
        <div className="flex items-start gap-2.5 rounded-control bg-surface-2 px-3 py-2.5 text-caption text-fg-muted">
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-fg-subtle" />
          <span>{t("karaokeVideo.note")}</span>
        </div>

        {/* Progress */}
        {status === "rendering" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 text-caption text-fg-muted">
              <span className="flex items-center gap-1.5">
                <Icon name="loader" size={14} className="text-accent" />
                <span>{t(`karaokeVideo.phase.${progress.phase}`)}</span>
              </span>
              <span className="tabular">
                {progress.totalFrames > 0
                  ? `${t("karaokeVideo.frames", { current: progress.frame, total: progress.totalFrames })} (${pct}%)`
                  : ""}
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-label={t(`karaokeVideo.phase.${progress.phase}`)}
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-fast"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Done */}
        {status === "done" && result && (
          <div className="flex items-center gap-2 rounded-control bg-success/15 px-3 py-2.5 text-body-sm text-fg">
            <Icon name="check" size={18} className="shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("karaokeVideo.done", { size: fmtBytes(result.blob.size) })}</div>
              <div className="truncate text-caption text-fg-muted" title={result.filename}>
                {result.filename}
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="flex items-start gap-2 rounded-control bg-danger/15 px-3 py-2.5 text-body-sm text-fg" role="alert">
            <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-danger" />
            <span>{errorMsg || t("karaokeVideo.error")}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export default ExportDialog;
