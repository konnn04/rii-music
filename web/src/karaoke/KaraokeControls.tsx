import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Slider } from "@/components/ui/Slider";
import { Tip } from "@/components/ui/Tips";
import { t } from "@/i18n";
import { engine } from "@/player/engine";
import { usePlayer } from "@/player/store";
import { ensureInstrumental, cancelSeparation } from "./separate";
import { setKaraokeMode, setKey, setVocal, useKaraoke, type KaraokeMode } from "./store";

const MODES: KaraokeMode[] = ["off", "quick", "ai"];

function fmtKey(k: number): string {
  if (k === 0) return "0";
  return k > 0 ? `+${k}` : `−${Math.abs(k)}`;
}

export function KaraokeControls() {
  const mode = useKaraoke((s) => s.mode);
  const vocal = useKaraoke((s) => s.vocal);
  const key = useKaraoke((s) => s.key);
  const sep = useKaraoke((s) => s.sep);
  const ready = useKaraoke((s) => s.ready);
  const trackId = usePlayer((s) => s.current?.track.id ?? null);

  const simple = engine.simpleMode;
  const vocalEnabled = mode === "quick" && !simple;
  const vocalPct = Math.round(vocal * 100);
  const sepForTrack = trackId && sep?.trackId === trackId ? sep : null;
  const isAiReady = mode === "ai" && !!trackId && !!ready[trackId];

  return (
    <div className="flex flex-col gap-3 rounded-card bg-white/[0.06] px-4 py-3 backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {/* Mode segmented control */}
        <div className="flex items-center gap-2">
          <span className="text-caption text-np-fg-muted">{t("karaoke.mode")}</span>
          <div role="radiogroup" aria-label={t("karaoke.mode")} className="inline-flex rounded-full bg-white/10 p-0.5">
            {MODES.map((m) => {
              const disabled = simple && m === "quick";
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  onClick={() => setKaraokeMode(m)}
                  className={`focus-ring h-8 rounded-full px-3 text-label transition-colors duration-fast disabled:pointer-events-none disabled:opacity-40 ${
                    active ? "bg-np-accent text-np-on-accent" : "text-np-fg-muted hover:text-fg"
                  }`}
                >
                  {t(`karaoke.modes.${m}`)}
                </button>
              );
            })}
          </div>
          <Tip label={t("karaoke.mode")}>
            <span className="whitespace-pre-line">{t("karaoke.modeTip")}</span>
          </Tip>
        </div>

        {/* Vocal level slider (0..100%) */}
        <div className="flex min-w-[180px] flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-caption text-np-fg-muted">{t("karaoke.vocal")}</span>
            <div className={`min-w-[100px] flex-1 ${vocalEnabled ? "" : "pointer-events-none opacity-40"}`} aria-disabled={!vocalEnabled}>
              <Slider
                label={t("karaoke.vocal")}
                value={mode === "ai" ? 0 : vocalPct}
                max={100}
                step={1}
                np
                valueText={`${mode === "ai" ? 0 : vocalPct}%`}
                onChange={(v) => {
                  if (vocalEnabled) setVocal(v / 100);
                }}
              />
            </div>
            <span className="w-9 shrink-0 text-right text-caption text-np-fg-muted tabular">
              {mode === "ai" ? "0%" : `${vocalPct}%`}
            </span>
          </div>
          {mode === "ai" && <span className="text-caption text-np-fg-muted/80">{t("karaoke.vocalAiHint")}</span>}
        </div>

        {/* Key shift (-6..+6) */}
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-caption text-np-fg-muted">{t("karaoke.key")}</span>
          <button
            type="button"
            aria-label={t("karaoke.keyDown")}
            disabled={simple || key <= -6}
            onClick={() => setKey(key - 1)}
            className="focus-ring flex size-8 items-center justify-center rounded-full bg-white/10 text-label text-fg transition-colors duration-fast hover:bg-white/20 disabled:pointer-events-none disabled:opacity-35"
          >
            −
          </button>
          <button
            type="button"
            aria-label={t("karaoke.keyReset")}
            title={t("karaoke.keyReset")}
            disabled={simple || key === 0}
            onClick={() => setKey(0)}
            className="focus-ring min-w-10 rounded-full px-2 py-1 text-center text-label text-fg tabular transition-colors duration-fast hover:bg-white/10 disabled:pointer-events-none disabled:opacity-70"
          >
            {fmtKey(key)}
          </button>
          <button
            type="button"
            aria-label={t("karaoke.keyUp")}
            disabled={simple || key >= 6}
            onClick={() => setKey(key + 1)}
            className="focus-ring flex size-8 items-center justify-center rounded-full bg-white/10 text-label text-fg transition-colors duration-fast hover:bg-white/20 disabled:pointer-events-none disabled:opacity-35"
          >
            +
          </button>
        </div>
      </div>

      {simple && <p className="text-caption text-warning">{t("karaoke.simpleModeHint")}</p>}

      {/* AI separation progress or error */}
      {sepForTrack && sepForTrack.phase === "error" && trackId && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-danger/15 px-3 py-2 text-body-sm text-fg" role="alert">
          <span className="flex min-w-0 items-center gap-2">
            <Icon name="alert" size={18} className="shrink-0 text-danger" />
            <span className="truncate">{sepForTrack.error || t("karaoke.phase.error")}</span>
          </span>
          <Button size="sm" icon="retry" onClick={() => void ensureInstrumental(trackId)}>
            {t("common.retry")}
          </Button>
        </div>
      )}

      {sepForTrack && sepForTrack.phase !== "error" && sepForTrack.phase !== "done" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-caption text-np-fg-muted">
            <span className="flex items-center gap-1.5">
              <Icon name="loader" size={14} className="text-np-accent" />
              {t(`karaoke.phase.${sepForTrack.phase}`)}
              {sepForTrack.backend && (
                <span className="text-fg-subtle">· {sepForTrack.backend === "cpu" ? t("karaoke.cpu") : sepForTrack.backend}</span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <span className="tabular">{Math.round(Math.max(0, Math.min(1, sepForTrack.progress)) * 100)}%</span>
              <button
                type="button"
                onClick={cancelSeparation}
                className="focus-ring rounded-full px-2 py-0.5 text-caption text-np-fg-muted hover:bg-white/10 hover:text-fg"
              >
                {t("common.cancel")}
              </button>
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-white/15"
            role="progressbar"
            aria-label={t(`karaoke.phase.${sepForTrack.phase}`)}
            aria-valuenow={Math.round(Math.max(0, Math.min(1, sepForTrack.progress)) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-np-accent transition-[width] duration-fast"
              style={{ width: `${Math.max(0, Math.min(100, sepForTrack.progress * 100))}%` }}
            />
          </div>
        </div>
      )}

      {isAiReady && (!sepForTrack || sepForTrack.phase === "done") && (
        <div className="flex items-center gap-1.5 text-caption text-success">
          <Icon name="check" size={14} />
          <span>{t("karaoke.aiReady")}</span>
        </div>
      )}
    </div>
  );
}
