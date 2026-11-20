import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Settings } from "@/lib/api";
import { queryClient, useMe } from "@/lib/queries";
import { useBranding } from "@/lib/branding";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/i18n";

const LANGS = ["vi", "en", "ko", "ja", "zh", "th"] as const;
const GENRES = ["pop", "ballad", "rap", "indie", "rnb", "edm", "rock", "lofi", "acoustic", "bolero", "anime"] as const;

/** First visit: which languages, genres and artists you like — a starting point before there is listening history. */
export function Onboarding() {
  const me = useMe().data?.user;
  const brand = useBranding();
  const [step, setStep] = useState(0);
  const [langs, setLangs] = useState<string[]>(["vi"]);
  const [genres, setGenres] = useState<string[]>([]);
  const [artists, setArtists] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const suggestions = useQuery({
    queryKey: ["onboardingArtists", langs.join(","), genres.join(",")],
    queryFn: () => api<{ artists: { name: string; image: string; lang: string }[] }>(`/api/onboarding/artists?langs=${langs.join(",")}&genres=${genres.join(",")}`),
    enabled: step === 2 && langs.length > 0,
    staleTime: Infinity,
  });
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const finish = async (skip = false) => {
    setBusy(true);
    try {
      const body: Partial<Settings> = skip ? { onboarded: true } : { onboarded: true, prefLangs: langs, prefGenres: genres, prefArtists: artists };
      const st = await api<Settings>("/api/settings", { method: "PUT", json: body });
      queryClient.setQueryData(["settings"], st);
      queryClient.invalidateQueries({ queryKey: ["home"] });
    } finally {
      setBusy(false);
    }
  };

  const addTyped = () => {
    const v = typed.trim();
    if (v && !artists.includes(v)) setArtists([...artists, v]);
    setTyped("");
  };

  const chip = (on: boolean) =>
    `focus-ring h-10 rounded-full px-4 text-label transition-colors duration-fast ${on ? "bg-accent text-fg-on-accent" : "bg-surface-2 text-fg hover:bg-surface-3"}`;

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 backdrop-blur-sm md:items-center" role="dialog" aria-modal aria-labelledby="onb-title">
      <div className="flex max-h-[92dvh] w-full max-w-xl flex-col rounded-t-sheet bg-surface-1 shadow-sheet md:rounded-sheet">
        <div className="flex items-center gap-3 px-6 pt-6">
          <img src={brand.logoUrl} alt="" className="size-9 rounded-xs object-contain" />
          <div className="min-w-0 flex-1">
            <h2 id="onb-title" className="text-title-2">
              {step === 0 ? t("onboarding.hello", { name: me?.name || "" }) : step === 1 ? t("onboarding.genresTitle") : t("onboarding.artistsTitle")}
            </h2>
            <p className="text-body-sm text-fg-muted">{t(`onboarding.step${step}`)}</p>
          </div>
          <span className="text-caption text-fg-subtle tabular">{step + 1}/3</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && (
            <div className="flex flex-wrap gap-2">
              {LANGS.map((l) => (
                <button key={l} className={chip(langs.includes(l))} aria-pressed={langs.includes(l)} onClick={() => toggle(langs, setLangs, l)}>
                  {t(`onboarding.lang.${l}`)}
                </button>
              ))}
            </div>
          )}
          {step === 1 && (
            <div className="flex flex-wrap gap-2">
              {GENRES.map((g) => (
                <button key={g} className={chip(genres.includes(g))} aria-pressed={genres.includes(g)} onClick={() => toggle(genres, setGenres, g)}>
                  {t(`onboarding.genre.${g}`)}
                </button>
              ))}
            </div>
          )}
          {step === 2 && (
            <div className="flex flex-col gap-4">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  addTyped();
                }}
              >
                <input className="input h-11 min-w-0 flex-1" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t("onboarding.typeArtist")} aria-label={t("onboarding.typeArtist")} />
                <Button type="submit" icon="plus" disabled={!typed.trim()}>
                  {t("common.add")}
                </Button>
              </form>
              {artists.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {artists.map((a) => (
                    <button key={a} className={chip(true) + " flex items-center gap-1"} onClick={() => toggle(artists, setArtists, a)} aria-label={t("onboarding.removeArtist", { name: a })}>
                      {a} <Icon name="close" size={14} />
                    </button>
                  ))}
                </div>
              )}
              <div>
                <div className="mb-2 text-label text-fg-muted">{t("onboarding.suggested")}</div>
                {suggestions.isLoading ? (
                  <div className="flex items-center gap-2 text-body-sm text-fg-muted">
                    <Icon name="loader" size={18} /> {t("common.loading")}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                    {suggestions.data?.artists
                      .filter((a) => !artists.includes(a.name))
                      .slice(0, 16)
                      .map((a) => (
                        <button key={a.name} className="focus-ring flex flex-col items-center gap-1.5 rounded-control p-1 text-center hover:bg-surface-2" onClick={() => toggle(artists, setArtists, a.name)}>
                          <img src={a.image} alt="" referrerPolicy="no-referrer" loading="lazy" className="aspect-square w-full rounded-full bg-surface-3 object-cover" />
                          <span className="line-clamp-2 text-caption">{a.name}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-6 py-4 pb-[calc(16px+env(safe-area-inset-bottom))] md:pb-4">
          <Button variant="ghost" onClick={() => finish(true)} disabled={busy}>
            {t("onboarding.skip")}
          </Button>
          <span className="flex-1" />
          {step > 0 && (
            <Button onClick={() => setStep(step - 1)} disabled={busy}>
              {t("common.back")}
            </Button>
          )}
          {step < 2 ? (
            <Button variant="primary" onClick={() => setStep(step + 1)} disabled={step === 0 && !langs.length}>
              {t("common.next")}
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => finish()}>
              {t("onboarding.start")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
