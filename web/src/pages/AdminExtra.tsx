import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Branding, type ServerSettings } from "@/lib/api";
import { queryClient } from "@/lib/queries";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tip } from "@/components/ui/Tips";
import { toast } from "@/components/ui/Toast";
import { t, locale } from "@/i18n";

function Card({ title, icon, tip, children, wide }: { title: string; icon: IconName; tip?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`flex flex-col gap-3 rounded-card bg-surface-1 p-4 ${wide ? "md:col-span-2" : ""}`}>
      <h3 className="flex items-center gap-2 text-title-3">
        <Icon name={icon} size={20} className="text-accent" />
        <span className="flex-1">{title}</span>
        {tip && <Tip>{tip}</Tip>}
      </h3>
      {children}
    </section>
  );
}

/** Site name, description and logo (title, SEO, PWA, header). */
export function BrandingCard() {
  const b = useQuery({ queryKey: ["branding"], queryFn: () => api<Branding>("/api/branding") });
  const [name, setName] = useState<string | null>(null);
  const [desc, setDesc] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!b.data) return null;
  const set = (v: Branding) => queryClient.setQueryData(["branding"], v);
  const save = async () => {
    setBusy(true);
    try {
      set(await api<Branding>("/api/admin/branding", { method: "PUT", json: { name: name ?? b.data.name, description: desc ?? b.data.description } }));
      setName(null);
      setDesc(null);
      toast(t("adminx.branding.saved"), "success");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const upload = async (f: File) => {
    try {
      set(await api<Branding>("/api/admin/branding/logo", { method: "POST", body: f, headers: { "Content-Type": f.type } }));
      toast(t("adminx.branding.logoSaved"), "success");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <Card title={t("adminx.branding.title")} icon="image" tip={t("adminx.branding.tip")}>
      <div className="flex items-center gap-3">
        <img src={b.data.logoUrl} alt="" className="size-14 rounded-control bg-surface-2 object-contain p-1" />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon="upload" onClick={() => file.current?.click()}>
            {t("adminx.branding.uploadLogo")}
          </Button>
          {b.data.customLogo && (
            <Button size="sm" variant="ghost" onClick={async () => set(await api<Branding>("/api/admin/branding/logo", { method: "DELETE" }))}>
              {t("adminx.branding.defaultLogo")}
            </Button>
          )}
        </div>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>
      <input className="input h-11" value={name ?? b.data.name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label={t("adminx.branding.name")} placeholder={t("adminx.branding.name")} />
      <textarea
        className="input min-h-20 py-2"
        value={desc ?? b.data.description}
        onChange={(e) => setDesc(e.target.value)}
        maxLength={200}
        aria-label={t("adminx.branding.description")}
        placeholder={t("adminx.branding.description")}
      />
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} disabled={name === null && desc === null} onClick={save}>
          {t("common.save")}
        </Button>
      </div>
    </Card>
  );
}

/** Discord presence: the server's Discord Application ID and where users get the agent. */
export function DiscordCard() {
  const srv = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api<ServerSettings>("/api/admin/settings") });
  const [appId, setAppId] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  if (!srv.data) return null;
  const save = async () => {
    try {
      const st = await api<ServerSettings>("/api/admin/settings", { method: "PUT", json: { ...srv.data, discordAppId: (appId ?? srv.data.discordAppId).trim(), agentUrl: (url ?? srv.data.agentUrl).trim() } });
      queryClient.setQueryData(["admin", "settings"], st);
      setAppId(null);
      setUrl(null);
      toast(t("adminx.discord.saved"), "success");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <Card title="Discord" icon="headphones" tip={t("adminx.discord.tip")}>
      <label className="flex flex-col gap-1.5 text-body-sm">
        {t("adminx.discord.appId")}
        <input className="input h-11 font-mono" inputMode="numeric" value={appId ?? srv.data.discordAppId} onChange={(e) => setAppId(e.target.value)} placeholder="123456789012345678" />
      </label>
      <label className="flex flex-col gap-1.5 text-body-sm">
        {t("adminx.discord.agentUrl")}
        <input className="input h-11" value={url ?? srv.data.agentUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/…/releases" />
      </label>
      <p className="text-caption text-fg-muted">{t("adminx.discord.agentUrlHint")}</p>
      <div className="flex justify-end">
        <Button variant="primary" disabled={appId === null && url === null} onClick={save}>
          {t("common.save")}
        </Button>
      </div>
    </Card>
  );
}

/** Suggestions and downloads: how much autoplay queues / downloads, auto-download per run, playlist size. */
export function LimitsCard() {
  const srv = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api<ServerSettings>("/api/admin/settings") });
  const [draft, setDraft] = useState<Partial<ServerSettings>>({});
  if (!srv.data) return null;
  const v = { ...srv.data, ...draft };
  const field = (key: "autoplayTarget" | "autoplayDownloads" | "autoDlPerRun" | "playlistMax", min: number, max: number) => (
    <label className="flex flex-col gap-1.5 text-body-sm">
      <span>{t(`adminx.limits.${key}`)}</span>
      <input
        className="input h-11 w-32 tabular"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={v[key]}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
      />
      <span className="text-caption text-fg-muted">{t(`adminx.limits.${key}Hint`, { min, max })}</span>
    </label>
  );
  const save = async () => {
    try {
      const st = await api<ServerSettings>("/api/admin/settings", { method: "PUT", json: v });
      queryClient.setQueryData(["admin", "settings"], st);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setDraft({});
      toast(t("adminx.limits.saved"), "success");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <Card title={t("adminx.limits.title")} icon="radio" tip={t("adminx.limits.tip")}>
      {field("autoplayTarget", 5, 50)}
      {field("autoplayDownloads", 0, 20)}
      {field("autoDlPerRun", 1, 50)}
      {field("playlistMax", 1, 1000)}
      <div className="flex justify-end">
        <Button variant="primary" disabled={Object.keys(draft).length === 0} onClick={save}>
          {t("common.save")}
        </Button>
      </div>
    </Card>
  );
}

type LogRec = { seq: number; time: number; level: string; msg: string; attrs?: Record<string, string> };
const levelColor: Record<string, string> = { DEBUG: "text-fg-subtle", INFO: "text-fg-muted", WARN: "text-warning", ERROR: "text-danger" };

/** Recent server logs, live (polled), with level and text filters. */
export function LogsPanel() {
  const [level, setLevel] = useState("INFO");
  const [q, setQ] = useState("");
  const [recs, setRecs] = useState<LogRec[]>([]);
  const [paused, setPaused] = useState(false);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    last.current = 0;
    setRecs([]);
  }, [level, q]);
  useEffect(() => {
    if (paused) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api<{ records: LogRec[] }>(`/api/admin/logs?since=${last.current}&level=${level}&q=${encodeURIComponent(q)}`);
        if (stop || !r.records.length) return;
        last.current = r.records[r.records.length - 1].seq;
        setRecs((xs) => [...xs, ...r.records].slice(-1500));
      } catch {
        /* keep polling */
      }
    };
    tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [level, q, paused]);
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [recs]);

  const text = () => recs.map((r) => `${new Date(r.time).toISOString()} ${r.level} ${r.msg} ${Object.entries(r.attrs ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")}`).join("\n");
  return (
    <Card title={t("adminx.logs.title")} icon="list" tip={t("adminx.logs.tip")} wide>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input h-9 w-auto" value={level} onChange={(e) => setLevel(e.target.value)} aria-label={t("adminx.logs.level")}>
          {["DEBUG", "INFO", "WARN", "ERROR"].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <input className="input h-9 min-w-0 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("adminx.logs.filter")} aria-label={t("adminx.logs.filter")} />
        <Button size="sm" icon={paused ? "play" : "pause"} onClick={() => setPaused(!paused)}>
          {paused ? t("adminx.logs.resume") : t("adminx.logs.pause")}
        </Button>
        <Button
          size="sm"
          icon="clipboard"
          onClick={() =>
            navigator.clipboard.writeText(text()).then(
              () => toast(t("common.copied")),
              () => toast(t("common.copyFailed"), "error"),
            )
          }
          aria-label={t("common.copy")}
        />
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-96 overflow-y-auto rounded-control bg-surface-2 p-2 font-mono text-caption leading-relaxed"
        role="log"
        aria-live="off"
      >
        {!recs.length && <p className="p-2 text-fg-muted">{t("adminx.logs.empty")}</p>}
        {recs.map((r) => (
          <div key={r.seq} className="whitespace-pre-wrap break-all">
            <span className="text-fg-subtle">{new Date(r.time).toLocaleTimeString(locale())}</span> <span className={`font-semibold ${levelColor[r.level] ?? ""}`}>{r.level.padEnd(5)}</span>{" "}
            <span className="text-fg">{r.msg}</span>
            {r.attrs && (
              <span className="text-fg-muted">
                {" "}
                {Object.entries(r.attrs)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")}
              </span>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
