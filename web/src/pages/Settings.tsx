import { useEffect, useRef, useState } from "react";
import { ApiTokens, DiscordPresence, LanguageSettings } from "./SettingsExtra";
import { Link } from "@tanstack/react-router";
import { api, type AutoDLStatus, type Me, type Settings } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { fmtAgo, fmtBytes } from "@/lib/format";
import { queryClient, useMe, useSaveSettings, useSettings } from "@/lib/queries";
import { t, tn, tsv } from "@/i18n";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { notify, toast } from "@/components/ui/Toast";
import { engine, isIOS } from "@/player/engine";
import { Slider } from "@/components/ui/Slider";
import { Spinner } from "@/components/ui/misc";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Avatar, PageHeader, LogoutButton } from "@/components/layout/AppShell";
import { ACCENTS, swatch } from "@/lib/theme";
import { AboutCard } from "@/components/AboutCard";
import { SoundButton } from "@/components/SoundButton";
import { clearStored, setOffline, useOffline } from "@/lib/offline";
import { useIsMobile } from "@/lib/useMedia";
import { UI_SCALES, getUiScale, setUiScale } from "@/lib/uiScale";
import { undoDislike, useDisliked } from "@/lib/dislike";
import { setLiteMode, useLite, type LiteMode } from "@/lib/lite";
import { getDesktopAutostart, isDesktop, openDesktopPath, pickDesktopFolder, setDesktopAutostart, useAppMode, checkDesktopUpdate, installDesktopUpdate, type DesktopUpdate } from "@/lib/desktop";
import { browserDeviceName, customDeviceName, deviceName, setCustomDeviceName } from "@/player/sync";
import { clearInstrumentals } from "@/karaoke/separate";
import { setKaraokeModel, useKaraoke } from "@/karaoke/store";
import { ModelPicker } from "@/karaoke/ModelPicker";

export function SettingsPage() {
  const { data } = useSettings();
  const save = useSaveSettings();
  const [cf, setCf] = useState<number | null>(null);
  const [uiScale, setScaleState] = useState(getUiScale);
  const mobile = useIsMobile();
  const isAdmin = useMe().data?.user.role === "admin";
  const isLocal = useAppMode() === "local";
  if (!data) return <Spinner />;
  const set = (p: Partial<Settings>) => save.mutate(p);

  return (
    <div>
      <PageHeader
        title={t("common.nav.settings")}
        actions={
          <div className="flex items-center gap-1 lg:hidden">
            {isAdmin && (
              <Link to="/admin" className="focus-ring state-layer flex h-10 items-center gap-1.5 rounded-full bg-surface-1 px-3 text-label">
                <Icon name="shield" size={18} className="text-accent" /> {t("common.nav.admin")}
              </Link>
            )}
            <LogoutButton />
          </div>
        }
      />
      <div className="flex max-w-2xl flex-col gap-6 px-4 md:px-6">
        {!isLocal && <AccountSettings />}
        <LanguageSettings />

        <Group title={t("settings.playback.title")} icon="play">
          <DeviceNameRow />
          <Row
            label={t("settings.playback.crossfade")}
            hint={data.crossfadeSec === 0 ? t("settings.playback.crossfadeOff") : tn("settings.playback.crossfadeOn", cf ?? data.crossfadeSec)}
          >
            <div className="flex w-full items-center gap-3 md:w-56">
              <Slider
                label={t("settings.playback.crossfadeDuration")}
                value={cf ?? data.crossfadeSec}
                max={12}
                step={1}
                onChange={setCf}
                onCommit={(v) => {
                  set({ crossfadeSec: v });
                  setCf(null);
                }}
                className="flex-1"
                valueText={tn("settings.playback.seconds", cf ?? data.crossfadeSec)}
              />
              <span className="w-8 text-right text-label tabular">{cf ?? data.crossfadeSec}s</span>
            </div>
          </Row>
          <Toggle label={t("settings.playback.gapless")} hint={t("settings.playback.gaplessHint")} on={data.gaplessAlbum} set={(v) => set({ gaplessAlbum: v })} />
          <Toggle label={t("settings.playback.normalize")} hint={t("settings.playback.normalizeHint")} on={data.normalize} set={(v) => set({ normalize: v })} />
          <Toggle
            label={t("settings.playback.simpleMode")}
            hint={t(isIOS ? "settings.playback.simpleModeHintIos" : "settings.playback.simpleModeHint")}
            on={engine.simpleMode}
            set={(v) => engine.setSimpleMode(v)}
          />
          <Row label={t("sound.title")} hint={t("sound.settingsHint")}>
            <SoundButton variant="button" />
          </Row>
          <KaraokeCacheRow />
        </Group>

        <AutoDownloadSettings data={data} set={set} />
        <OfflineSettings />
        <DislikedSettings />

        <Group title={t("settings.appearance.title")} icon="sun">
          <Row label={t("settings.appearance.theme")}>
            <Segmented
              value={data.theme}
              options={[
                ["dark", t("settings.appearance.dark")],
                ["light", t("settings.appearance.light")],
                ["system", t("settings.appearance.system")],
              ]}
              onChange={(v) => set({ theme: v as Settings["theme"] })}
            />
          </Row>
          <AccentPicker value={data.accent} onChange={(accent) => set({ accent })} />
          {mobile && (
            <Row label={t("settings.appearance.uiScale")} hint={t("settings.appearance.uiScaleHint")}>
              <Segmented
                value={String(uiScale)}
                options={UI_SCALES.map((s): [string, string] => [String(s), `${Math.round(s * 100)}%`])}
                onChange={(v) => {
                  const n = Number(v);
                  setUiScale(n);
                  setScaleState(n);
                }}
              />
            </Row>
          )}
          <Toggle
            label={t("settings.appearance.visualizer")}
            hint={t(engine.simpleMode ? "settings.appearance.visualizerSimple" : "settings.appearance.visualizerHint")}
            on={data.visualizer}
            set={(v) => set({ visualizer: v })}
          />
          <LiteRow />
        </Group>

        {isDesktop() && <DesktopSettings />}

        {(isDesktop() || !isLocal) && <DiscordPresence />}
        {!isLocal && <ApiTokens />}
        <DataSettings />

        <Group title={t("settings.shortcuts.title")} icon="keyboard">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 py-2 text-body-sm">
            {[
              ["Space", t("settings.shortcuts.playPause")],
              ["← / →", t("settings.shortcuts.seek")],
              ["Shift + ← / →", t("settings.shortcuts.prevNext")],
              ["M", t("settings.shortcuts.mute")],
              ["L", t("settings.shortcuts.lyrics")],
              ["K", t("karaoke.shortcutToggle")],
              ["Q", t("settings.shortcuts.queue")],
              ["/", t("common.nav.search")],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt>
                  <kbd className="rounded-xs bg-surface-2 px-2 py-0.5 font-sans text-caption">{k}</kbd>
                </dt>
                <dd className="text-fg-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </Group>
        <AboutCard />
      </div>
    </div>
  );
}

function KaraokeCacheRow() {
  const [busy, setBusy] = useState(false);
  const model = useKaraoke((s) => s.model);
  const clear = async () => {
    setBusy(true);
    try {
      const bytes = await clearInstrumentals();
      notify({
        icon: "mic",
        kind: "success",
        text: bytes > 0 ? t("karaoke.cleared", { size: fmtBytes(bytes) }) : t("karaoke.clearedEmpty"),
      });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row label={t("karaoke.model.label")} hint={t("karaoke.model.hint")}>
        <div className="w-full max-w-md">
          <ModelPicker value={model} onChange={setKaraokeModel} />
        </div>
      </Row>
      <Row label={t("karaoke.title")} hint={t("karaoke.settingsHint")}>
        <Button variant="ghost" icon="trash" loading={busy} onClick={() => void clear()}>
          {t("karaoke.clearCache")}
        </Button>
      </Row>
    </>
  );
}

function AutoDownloadSettings({ data, set }: { data: Settings; set: (p: Partial<Settings>) => void }) {
  const st = useQuery({ queryKey: ["autodl"], queryFn: () => api<AutoDLStatus>("/api/autodl"), refetchInterval: 60_000 });
  const [running, setRunning] = useState(false);
  const s = st.data;
  const pct = s ? Math.min(100, (s.usedBytes / s.limitBytes) * 100) : 0;
  return (
    <Group title={t("settings.autoDl.title")} icon="radio">
      <Toggle
        label={t("settings.autoDl.title")}
        hint={t("settings.autoDl.hint")}
        on={data.autoDownload}
        set={(v) => set({ autoDownload: v })}
      />
      <p className="py-3 text-body-sm text-fg-muted">{t("settings.autoDl.evictionNote")}</p>
      {s && (
        <div className="flex flex-col gap-3 py-4">
          <div className="flex items-baseline justify-between text-body-sm">
            <span>{t("settings.autoDl.used", { used: fmtBytes(s.usedBytes), limit: fmtBytes(s.limitBytes) })}</span>
            <span className="text-fg-muted">
              {tn("common.songs", s.tracks)} · {tn("settings.autoDl.autoCount", s.autoTracks)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label={t("settings.storageMeter")} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full rounded-full ${pct >= 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
          </div>
          {data.autoDownload && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 text-body-sm text-fg-muted">
                {s.running
                  ? t("settings.autoDl.running")
                  : s.lastRun
                    ? s.lastEvicted
                      ? tn("settings.autoDl.lastRunEvicted", s.lastEvicted, { ago: fmtAgo(s.lastRun), msg: tsv(s.lastMessage) })
                      : t("settings.autoDl.lastRun", { ago: fmtAgo(s.lastRun), msg: tsv(s.lastMessage) })
                    : t("settings.autoDl.neverRun")}
                {s.pending > 0 && ` ${tn("settings.autoDl.pending", s.pending)}`}
              </div>
              <Button
                size="sm"
                icon="retry"
                loading={running || s.running}
                onClick={async () => {
                  setRunning(true);
                  try {
                    await api("/api/autodl/run", { method: "POST" });
                    toast(t("settings.autoDl.startedToast"), "success");
                  } finally {
                    setRunning(false);
                  }
                }}
              >
                {t("settings.autoDl.runNow")}
              </Button>
            </div>
          )}
        </div>
      )}
    </Group>
  );
}

function AccountSettings() {
  const me = useMe();
  const [name, setName] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const u = me.data?.user;
  if (!u || !me.data) return null;
  const pct = Math.min(100, (me.data.usedBytes / me.data.limitBytes) * 100);
  const saveName = async () => {
    const d = await api<Me>("/api/me", { method: "PATCH", json: { name: (name ?? "").trim() } });
    queryClient.setQueryData(["me"], d);
    setName(null);
    toast(t("settings.account.nameSaved"), "success");
  };
  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (pw.next !== pw.confirm) {
      setErr(t("settings.account.pwMismatch"));
      return;
    }
    setBusy(true);
    try {
      const d = await api<Me>("/api/me/password", { method: "POST", json: { current: pw.current, password: pw.next, confirm: pw.confirm } });
      queryClient.setQueryData(["me"], d);
      setPw({ current: "", next: "", confirm: "" });
      toast(t(u.hasPassword ? "settings.account.pwChanged" : "settings.account.pwSet"), "success");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title={t("common.nav.account")} icon="users">
      <div className="flex items-center gap-3 py-4">
        <Avatar name={u.name || u.email} size={48} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body">{u.name || t("settings.account.unnamed")}</div>
          <div className="truncate text-body-sm text-fg-muted">
            {u.email} · {t(u.role === "admin" ? "settings.account.roleAdmin" : "settings.account.roleListener")}
          </div>
        </div>
      </div>
      <Row label={t("settings.account.displayName")}>
        <div className="flex w-full gap-2 md:w-72">
          <input className="input h-11 min-w-0 flex-1" value={name ?? u.name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("settings.account.namePlaceholder")} />
          <Button disabled={name === null || name.trim() === u.name} onClick={saveName}>
            {t("common.save")}
          </Button>
        </div>
      </Row>
      <div className="flex flex-col gap-2 py-4">
        <div className="flex items-baseline justify-between text-body-sm">
          <span>{t("settings.account.storage")}</span>
          <span className="text-fg-muted">
            {fmtBytes(me.data.usedBytes)} / {fmtBytes(me.data.limitBytes)} · {tn("common.songs", me.data.tracks)}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label={t("settings.storageMeter")} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${pct >= 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-caption text-fg-muted">{t("settings.account.storageNote")}</p>
      </div>
      <form onSubmit={changePw} className="flex flex-col gap-3 py-4">
        <div className="text-body">{t(u.hasPassword ? "settings.account.changePw" : "settings.account.setPw")}</div>
        {!u.hasPassword && <p className="-mt-2 text-body-sm text-fg-muted">{t("settings.account.setPwHint")}</p>}
        <input type="text" autoComplete="username" value={u.email} readOnly hidden />
        {u.hasPassword && (
          <input className="input h-11" type="password" autoComplete="current-password" placeholder={t("settings.account.currentPw")} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        )}
        <input className="input h-11" type="password" autoComplete="new-password" placeholder={t("settings.account.newPw")} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        <input className="input h-11" type="password" autoComplete="new-password" placeholder={t("settings.account.confirmPw")} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        {err && (
          <p role="alert" className="text-body-sm text-danger">
            {err}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-caption text-fg-muted">{t("settings.account.forgotPwHint")}</span>
          <Button type="submit" variant="primary" loading={busy} disabled={(u.hasPassword && !pw.current) || pw.next.length < 8 || !pw.confirm}>
            {t(u.hasPassword ? "settings.account.changePw" : "settings.account.setPw")}
          </Button>
        </div>
      </form>
      <p className="py-3 text-caption text-fg-subtle">{t("settings.account.privacyNote")}</p>
    </Group>
  );
}

/** Chế độ nhẹ: fewer effects on weak devices (auto-detected by default). */
function LiteRow() {
  const lite = useLite();
  const hint =
    lite.active && lite.mode === "auto"
      ? t(`settings.appearance.liteOnBecause.${lite.reason || "device"}`)
      : t("settings.appearance.liteHint");
  return (
    <Row label={t("settings.appearance.lite")} hint={hint}>
      <Segmented
        value={lite.mode}
        options={[
          ["auto", t("settings.appearance.liteAuto")],
          ["on", t("settings.appearance.liteOn")],
          ["off", t("settings.appearance.liteOff")],
        ]}
        onChange={(v) => setLiteMode(v as LiteMode)}
      />
    </Row>
  );
}

/** Không thích: artists and songs never suggested, with a way to take them back. */
function DislikedSettings() {
  const { data } = useDisliked();
  const list = data ?? [];
  return (
    <Group title={t("settings.disliked.title")} icon="close">
      <p className="py-2 text-body-sm text-fg-muted">{t("settings.disliked.hint")}</p>
      {list.length === 0 ? (
        <p className="pb-3 text-body-sm text-fg-subtle">{t("settings.disliked.empty")}</p>
      ) : (
        <ul className="flex flex-col pb-2">
          {list.map((d) => (
            <li key={d.kind + d.key} className="flex min-h-12 items-center gap-3">
              <Icon name={d.kind === "artist" ? "artist" : "music-note"} size={20} className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body">{d.name}</span>
                <span className="block truncate text-caption text-fg-muted">
                  {d.kind === "artist" ? t("settings.disliked.artist") : d.artist || t("settings.disliked.song")}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void undoDislike(d.kind, d.key).then(() => toast(t("settings.disliked.removed", { name: d.name })))}
              >
                {t("settings.disliked.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

function Group({ title, icon, children }: { title: string; icon: IconName; children: React.ReactNode }) {
  return (
    <section className="rounded-card bg-surface-1 px-4 py-2">
      <h2 className="flex h-12 items-center gap-2 text-title-3">
        <Icon name={icon} size={20} className="text-accent" />
        {title}
      </h2>
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-4 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-body">{label}</div>
        {hint && <div className="text-body-sm text-fg-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, hint, on, set }: { label: string; hint?: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 py-4">
      <div className="min-w-0 flex-1">
        <div className="text-body" id={`t-${label}`}>
          {label}
        </div>
        {hint && <div className="text-body-sm text-fg-muted">{hint}</div>}
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-labelledby={`t-${label}`}
        onClick={() => set(!on)}
        className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors duration-fast ${on ? "bg-accent" : "bg-surface-4"}`}
      >
        <span className={`absolute top-1 size-5 rounded-full bg-fg transition-[left] duration-fast ${on ? "left-6 !bg-fg-on-accent" : "left-1"}`} />
      </button>
    </div>
  );
}

/** Nghe offline: off by default; this device only. */
function OfflineSettings() {
  const o = useOffline();
  const [busy, setBusy] = useState(false);
  const pinned = [...o.stored.values()].filter(Boolean).length;
  return (
    <Group title={t("settings.offline.title")} icon="download">
      <Toggle label={t("settings.offline.enable")} hint={t("settings.offline.enableHint")} on={o.enabled} set={(v) => void setOffline({ enabled: v })} />
      {o.enabled && (
        <>
          <Toggle label={t("settings.offline.autoCache")} hint={t("settings.offline.autoCacheHint")} on={o.autoCache} set={(v) => void setOffline({ autoCache: v })} />
          <Row label={t("settings.offline.retention")} hint={t("settings.offline.retentionHint")}>
            <Segmented
              value={String(o.retentionDays)}
              options={[
                ["30", tn("settings.offline.days", 30)],
                ["60", tn("settings.offline.days", 60)],
                ["90", tn("settings.offline.days", 90)],
              ]}
              onChange={(v) => void setOffline({ retentionDays: Number(v) as 30 | 60 | 90 })}
            />
          </Row>
        </>
      )}
      <Row
        label={t("settings.offline.stored", { n: o.stored.size, size: fmtBytes(o.bytes) })}
        hint={pinned ? tn("settings.offline.pinned", pinned) : t("settings.offline.pinHint")}
      >
        <Button
          variant="ghost"
          icon="trash"
          disabled={!o.stored.size || busy}
          onClick={async () => {
            setBusy(true);
            await clearStored();
            setBusy(false);
            toast(t("settings.offline.cleared"));
          }}
        >
          {t("settings.offline.clear")}
        </Button>
      </Row>
    </Group>
  );
}

/** 12 rainbow accents plus "follow the song's cover". */
function AccentPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const name = (id: string) => t(`settings.appearance.accents.${id}`);
  return (
    <div className="flex flex-col gap-3 py-4">
      <div>
        <div className="text-body" id="accent-label">
          {t("settings.appearance.accent")}
        </div>
        <div className="text-body-sm text-fg-muted">
          {value === "song" ? t("settings.appearance.accentSongHint") : value === "indigo" ? t("settings.appearance.accentDefaultHint") : name(value)}
        </div>
      </div>
      <div role="radiogroup" aria-labelledby="accent-label" className="grid grid-cols-7 gap-2 sm:grid-cols-[repeat(13,minmax(0,1fr))]">
        {ACCENTS.map((a) => (
          <Swatch key={a.id} on={value === a.id} label={name(a.id)} onClick={() => onChange(a.id)} style={{ background: swatch(a) }} />
        ))}
        <Swatch
          on={value === "song"}
          label={t("settings.appearance.accentSong")}
          onClick={() => onChange("song")}
          style={{ background: "conic-gradient(from 90deg, hsl(0 85% 72%), hsl(60 90% 72%), hsl(140 60% 72%), hsl(200 80% 72%), hsl(262 85% 72%), hsl(325 80% 72%), hsl(0 85% 72%))" }}
        >
          <Icon name="music-note" size={18} className="text-[#0E0F12]" />
        </Swatch>
      </div>
    </div>
  );
}

function Swatch({ on, label, onClick, style, children }: { on: boolean; label: string; onClick: () => void; style: React.CSSProperties; children?: React.ReactNode }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`focus-ring relative flex aspect-square w-full max-w-11 items-center justify-center rounded-full transition-transform duration-fast hover:scale-110 ${
        on ? "ring-2 ring-fg ring-offset-2 ring-offset-surface-1" : ""
      }`}
      style={style}
    >
      {children}
      {on && !children && <Icon name="check" size={18} className="text-[#0E0F12]" />}
    </button>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-control bg-surface-2 p-1">
      {options.map(([k, label]) => (
        <button
          key={k}
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={`focus-ring h-9 rounded-[6px] px-4 text-label transition-colors duration-fast ${value === k ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function DataSettings() {
  const [scope, setScope] = useState<"history" | "all" | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const phrase = scope === "all" ? t("settings.data.phraseAll") : t("settings.data.phraseHistory");
  const close = () => {
    setScope(null);
    setTyped("");
  };
  const run = async () => {
    if (!scope) return;
    setBusy(true);
    try {
      await api("/api/reset", { method: "POST", json: { scope, confirm: "XOA" } });
      if (scope === "all") {
        localStorage.removeItem("rii-player");
        localStorage.removeItem("rii-pos");
        location.replace("/");
        return;
      }
      queryClient.invalidateQueries();
      toast(t("settings.data.historyCleared"), "success");
      close();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title={t("settings.data.title")} icon="trash">
      <Row label={t("settings.data.clearHistory")} hint={t("settings.data.clearHistoryHint")}>
        <Button variant="danger" onClick={() => setScope("history")}>
          {t("settings.data.clearHistoryBtn")}
        </Button>
      </Row>
      <Row label={t("settings.data.clearAll")} hint={t("settings.data.clearAllHint")}>
        <Button variant="danger" icon="trash" onClick={() => setScope("all")}>
          {t("settings.data.clearAllBtn")}
        </Button>
      </Row>
      {scope && (
        <Dialog
          open
          onOpenChange={(o) => !o && close()}
          title={t(scope === "all" ? "settings.data.confirmAllTitle" : "settings.data.confirmHistoryTitle")}
          description={t(scope === "all" ? "settings.data.confirmAllDesc" : "settings.data.confirmHistoryDesc")}
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" icon="trash" loading={busy} disabled={typed.trim().toUpperCase() !== phrase} onClick={run}>
                {t("common.delete")}
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-body-sm text-fg-muted">
              {t("settings.data.typeToConfirmBefore")}
              <strong className="text-fg">{phrase}</strong>
              {t("settings.data.typeToConfirmAfter")}
            </span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
          </label>
        </Dialog>
      )}
    </Group>
  );
}

type LocalInfo = {
  mode: string;
  musicDir: string;
  dataDir: string;
  encrypted: boolean;
  move: {
    running: boolean;
    done: number;
    total: number;
    error: string;
    to: string;
  };
};

/** "Tên thiết bị này": how this device appears to your other devices (remote control). */
function DeviceNameRow() {
  const [value, setValue] = useState(customDeviceName());
  const save = () => {
    setCustomDeviceName(value);
    toast(t("settings.device.saved", { name: deviceName() }));
  };
  return (
    <Row label={t("settings.device.name")} hint={t("settings.device.hint", { name: deviceName() })}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input className="input h-10 w-44" value={value} maxLength={60} placeholder={browserDeviceName()} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" disabled={value.trim() === customDeviceName()}>
          {t("common.save")}
        </Button>
      </form>
    </Row>
  );
}

/** "Kiểm tra cập nhật": the desktop app's own version and updates. */
function UpdateRow() {
  const [state, setState] = useState<{ busy: boolean; info: DesktopUpdate | null }>({ busy: false, info: null });
  const check = async () => {
    setState({ busy: true, info: null });
    try {
      const info = await checkDesktopUpdate();
      setState({ busy: false, info });
      if (info && !info.version) toast(t("settings.desktop.upToDate", { version: info.current }));
    } catch (e) {
      setState({ busy: false, info: null });
      toast((e as Error).message, "error");
    }
  };
  const install = async () => {
    setState((s) => ({ ...s, busy: true }));
    toast(t("settings.desktop.installing"));
    try {
      await installDesktopUpdate(); // the app restarts
    } catch (e) {
      setState((s) => ({ ...s, busy: false }));
      toast((e as Error).message, "error");
    }
  };
  const v = state.info?.version;
  return (
    <Row
      label={t("settings.desktop.update")}
      hint={v ? t("settings.desktop.updateAvailable", { version: v }) : state.info ? t("settings.desktop.upToDate", { version: state.info.current }) : t("settings.desktop.updateHint")}
    >
      {v ? (
        <Button variant="primary" icon="download" loading={state.busy} onClick={install}>
          {t("settings.desktop.updateNow")}
        </Button>
      ) : (
        <Button icon="retry" loading={state.busy} onClick={check}>
          {t("settings.desktop.checkUpdate")}
        </Button>
      )}
    </Row>
  );
}

function DesktopSettings() {
  const isLocal = useAppMode() === "local";
  const [autostart, setAutostartState] = useState(false);
  const [confirmDir, setConfirmDir] = useState<string | null>(null);
  const [startingMove, setStartingMove] = useState(false);
  const [moveStartedAt, setMoveStartedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void getDesktopAutostart().then((v) => {
      if (active) setAutostartState(v);
    });
    return () => {
      active = false;
    };
  }, []);

  const local = useQuery({
    queryKey: ["localInfo"],
    queryFn: () => api<LocalInfo>("/api/local"),
    enabled: isLocal,
    refetchInterval: (q) => (q.state.data?.move.running || moveStartedAt !== null ? 1000 : false),
  });

  const prevRunning = useRef(false);
  useEffect(() => {
    const mv = local.data?.move;
    if (!mv) return;
    const finishedFromRunning = prevRunning.current && !mv.running;
    const finishedFast = moveStartedAt !== null && !mv.running && local.dataUpdatedAt > moveStartedAt;
    prevRunning.current = mv.running;
    if (finishedFromRunning || finishedFast) {
      setMoveStartedAt(null);
      if (mv.error) toast(mv.error, "error");
      else toast(t("settings.desktop.movedToast"), "success");
    }
  }, [local.data, local.dataUpdatedAt, moveStartedAt]);

  const toggleAutostart = async (next: boolean) => {
    setAutostartState(next);
    try {
      await setDesktopAutostart(next);
    } catch (e) {
      setAutostartState(!next);
      toast((e as Error)?.message ?? t("common.error"), "error");
    }
  };

  const pickFolder = async () => {
    try {
      const picked = await pickDesktopFolder(t("settings.desktop.musicDir"), local.data?.musicDir);
      if (picked) setConfirmDir(picked);
    } catch (e) {
      toast((e as Error)?.message ?? t("common.error"), "error");
    }
  };

  const startMove = async () => {
    if (!confirmDir) return;
    setStartingMove(true);
    try {
      const startedAt = Date.now();
      await api("/api/local/music-dir", { method: "POST", json: { path: confirmDir } });
      setConfirmDir(null);
      setMoveStartedAt(startedAt);
      void local.refetch();
    } catch (e) {
      toast((e as Error)?.message ?? t("common.error"), "error");
    } finally {
      setStartingMove(false);
    }
  };

  const mv = local.data?.move;
  const isMoving = !!mv?.running || moveStartedAt !== null;

  return (
    <Group title={t("settings.desktop.title")} icon="devices">
      <Toggle label={t("settings.desktop.autostart")} on={autostart} set={(v) => void toggleAutostart(v)} />
      <UpdateRow />
      {isLocal && (
        <>
          <Row
            label={t("settings.desktop.musicDir")}
            hint={
              isMoving
                ? t("settings.desktop.moving", { done: mv?.done ?? 0, total: mv?.total ?? 0 })
                : local.data?.musicDir
                  ? `${local.data.musicDir} — ${t("settings.desktop.musicDirHint")}`
                  : t("settings.desktop.musicDirHint")
            }
          >
            <Button size="sm" loading={isMoving} onClick={() => void pickFolder()}>
              {t("settings.desktop.changeDir")}
            </Button>
          </Row>
          <Row label={t("settings.desktop.dataDir")} hint={local.data?.dataDir ?? ""}>
            <Button
              size="sm"
              disabled={!local.data?.dataDir}
              onClick={() => {
                if (!local.data?.dataDir) return;
                void openDesktopPath(local.data.dataDir).catch((e) =>
                  toast((e as Error)?.message ?? t("common.error"), "error"),
                );
              }}
            >
              {t("settings.desktop.openDir")}
            </Button>
          </Row>
        </>
      )}
      <Row label={t("settings.desktop.mode")} hint={t("settings.desktop.switchModeHint")}>
        <Button
          icon="devices"
          onClick={() => {
            if (window.confirm(t("settings.desktop.switchConfirm"))) void window.__TAURI__?.core?.invoke("switch_mode");
          }}
        >
          {t("settings.desktop.switchMode")}
        </Button>
      </Row>
      {confirmDir && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirmDir(null)}
          title={t("settings.desktop.confirmMoveTitle")}
          description={t("settings.desktop.confirmMoveDesc", { path: confirmDir })}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDir(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" loading={startingMove} onClick={() => void startMove()}>
                {t("settings.desktop.confirmMoveBtn")}
              </Button>
            </>
          }
        />
      )}
    </Group>
  );
}
