import { t } from "@/i18n";
import { MODEL_IDS, MODELS, type ModelId } from "./models";

/** Choice of the AI separation model: name, size and what it does. */
export function ModelPicker({ value, onChange, dark = false }: { value: ModelId; onChange: (m: ModelId) => void; dark?: boolean }) {
  return (
    <div role="radiogroup" aria-label={t("karaoke.model.label")} className="flex flex-col gap-2">
      {MODEL_IDS.map((id) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className={`focus-ring flex items-start gap-3 rounded-control border px-3 py-2.5 text-left transition-colors duration-fast ${
              active ? "border-accent bg-accent/10" : dark ? "border-white/10 hover:bg-white/5" : "border-line hover:bg-surface-4"
            }`}
          >
            <span className={`mt-1 size-3.5 shrink-0 rounded-full border-2 ${active ? "border-accent bg-accent" : "border-fg-subtle"}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-label">{t(`karaoke.model.${id}.name`)}</span>
                <span className="tabular shrink-0 text-caption text-fg-muted">~{MODELS[id].sizeMb} MB</span>
              </span>
              <span className="block text-caption text-fg-muted">{t(`karaoke.model.${id}.desc`)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
