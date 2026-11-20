import { useId } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Slider } from "@/components/ui/Slider";
import { Button } from "@/components/ui/Button";
import { EQ_BANDS, EQ_PRESETS, useFx } from "@/player/fx";
import { t } from "@/i18n";

const PRESET_KEYS = ["flat", "bass", "treble", "vocal", "pop", "rock", "acoustic", "electronic", "night"] as const;

function fmtBand(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

function fmtBandAria(hz: number): string {
  return hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
}

function fmtDb(v: number): string {
  if (v === 0) return "0";
  return v > 0 ? `+${v}` : String(v);
}

export function SoundDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const enabled = useFx((s) => s.enabled);
  const preset = useFx((s) => s.preset);
  const eq = useFx((s) => s.eq);
  const bass = useFx((s) => s.bass);
  const exciter = useFx((s) => s.exciter);
  const crossfeed = useFx((s) => s.crossfeed);
  const width = useFx((s) => s.width);
  const limiter = useFx((s) => s.limiter);
  const set = useFx((s) => s.set);
  const reset = useFx((s) => s.reset);

  const pickPreset = (name: string) => {
    const gains = EQ_PRESETS[name];
    if (gains) set({ preset: name, eq: [...gains] });
  };

  const setBand = (index: number, gain: number) => {
    const next = EQ_BANDS.map((_, i) => (i === index ? gain : (eq[i] ?? 0)));
    set({ eq: next, preset: "custom" });
  };

  const widthSlider = Math.round((width - 0.5) * 20);
  const widthText = Math.abs(width - 1) < 0.001 ? t("sound.widthOriginal") : `${Math.round(width * 100)}%`;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={t("sound.title")}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <p className="text-caption text-fg-muted">{t("sound.note")}</p>
          <Button size="sm" variant="secondary" onClick={reset}>
            {t("sound.reset")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <SwitchRow label={t("sound.enable")} on={enabled} onChange={(v) => set({ enabled: v })} />

        <div className={`flex flex-col gap-5 transition-opacity duration-fast ${enabled ? "" : "opacity-50"}`}>
          {/* Presets */}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("sound.presetsLabel")}>
            {PRESET_KEYS.map((key) => {
              const active = preset === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => pickPreset(key)}
                  className={`focus-ring h-8 rounded-full px-3 text-caption transition-colors duration-fast ${
                    active ? "bg-accent text-fg-on-accent" : "bg-surface-2 text-fg-muted state-layer hover:text-fg"
                  }`}
                >
                  {t(`sound.presets.${key}`)}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={preset === "custom"}
              onClick={() => set({ preset: "custom" })}
              className={`focus-ring h-8 rounded-full px-3 text-caption transition-colors duration-fast ${
                preset === "custom" ? "bg-accent text-fg-on-accent" : "bg-surface-2 text-fg-muted state-layer hover:text-fg"
              }`}
            >
              {t("sound.presets.custom")}
            </button>
          </div>

          {/* 10-band Equalizer */}
          <div className="rounded-card bg-surface-2 px-2 py-3">
            <div className="mb-2 flex items-baseline justify-between px-1">
              <span className="text-label">{t("sound.eq")}</span>
              <span className="text-caption text-fg-muted">{t("sound.eqUnit")}</span>
            </div>
            <div className="grid grid-cols-10 gap-0.5">
              {EQ_BANDS.map((hz, i) => {
                const val = eq[i] ?? 0;
                return (
                  <div key={hz} className="flex flex-col items-center gap-1">
                    <span className="text-[10px] leading-tight text-fg-muted tabular">{fmtDb(val)}</span>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={0.5}
                      value={val}
                      onChange={(e) => setBand(i, Number(e.target.value))}
                      aria-label={fmtBandAria(hz)}
                      aria-valuetext={`${fmtDb(val)} ${t("sound.eqUnit")}`}
                      className="focus-ring h-[120px] w-6 cursor-pointer accent-[var(--vg-accent)] [writing-mode:vertical-lr] [direction:rtl]"
                    />
                    <span className="text-[10px] leading-tight text-fg-subtle tabular">{fmtBand(hz)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tone & spatial sliders */}
          <div className="flex flex-col gap-4">
            <EffectSlider
              label={t("sound.bass")}
              hint={t("sound.bassHint")}
              value={Math.round(bass * 100)}
              max={100}
              valueText={`${Math.round(bass * 100)}%`}
              onChange={(v) => set({ bass: v / 100 })}
            />
            <EffectSlider
              label={t("sound.exciter")}
              hint={t("sound.exciterHint")}
              value={Math.round(exciter * 100)}
              max={100}
              valueText={`${Math.round(exciter * 100)}%`}
              onChange={(v) => set({ exciter: v / 100 })}
            />
            <EffectSlider
              label={t("sound.crossfeed")}
              hint={t("sound.crossfeedHint")}
              value={Math.round(crossfeed * 100)}
              max={100}
              valueText={`${Math.round(crossfeed * 100)}%`}
              onChange={(v) => set({ crossfeed: v / 100 })}
            />
            <EffectSlider
              label={t("sound.width")}
              hint={t("sound.widthHint")}
              value={widthSlider}
              max={22}
              valueText={widthText}
              onChange={(v) => set({ width: Math.round((0.5 + v * 0.05) * 100) / 100 })}
            />
          </div>

          {/* Limiter */}
          <SwitchRow label={t("sound.limiter")} hint={t("sound.limiterHint")} on={limiter} onChange={(v) => set({ limiter: v })} />
        </div>
      </div>
    </Dialog>
  );
}

function SwitchRow({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-body" id={id}>
          {label}
        </div>
        {hint && <div className="text-caption text-fg-muted">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={id}
        onClick={() => onChange(!on)}
        className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors duration-fast ${on ? "bg-accent" : "bg-surface-4"}`}
      >
        <span className={`absolute top-1 size-5 rounded-full bg-fg transition-[left] duration-fast ${on ? "left-6 !bg-fg-on-accent" : "left-1"}`} />
      </button>
    </div>
  );
}

function EffectSlider({
  label,
  hint,
  value,
  max,
  valueText,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  max: number;
  valueText: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label">{label}</span>
        <span className="text-caption text-fg-muted tabular">{valueText}</span>
      </div>
      <Slider label={label} value={value} max={max} step={1} onChange={onChange} valueText={valueText} />
      <p className="text-caption text-fg-muted">{hint}</p>
    </div>
  );
}
