import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type APIToken, type Settings } from "@/lib/api";
import { queryClient, useSettings } from "@/lib/queries";
import { fmtAgo, fmtBytes } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tip, resetHints } from "@/components/ui/Tips";
import { notify, toast } from "@/components/ui/Toast";
import { LANGS, lang, setLang, t } from "@/i18n";

function Card({ title, icon, tip, children }: { title: string; icon: IconName; tip?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card bg-surface-1 px-4 py-2">
      <h2 className="flex h-12 items-center gap-2 text-title-3">
        <Icon name={icon} size={20} className="text-accent" />
        {title}
        {tip && <Tip>{tip}</Tip>}
      </h2>
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </section>
  );
}

function copy(s: string) {
  navigator.clipboard.writeText(s).then(
    () => toast(t("common.copied")),
    () => toast(t("common.copyFailed"), "error"),
  );
}

async function saveSettings(p: Partial<Settings>) {
  const st = await api<Settings>("/api/settings", { method: "PUT", json: p });
  queryClient.setQueryData(["settings"], st);
  return st;
}

/** Interface language (stored in the account, so it follows you across devices). */
export function LanguageSettings() {
  return (
    <Card title={t("settingsx.language.title")} icon="globe">
      <div className="flex flex-wrap items-center gap-2 py-4">
        {LANGS.map((l) => (
          <button
            key={l.code}
            onClick={async () => {
              if (l.code === lang) return;
              await saveSettings({ language: l.code }).catch(() => {});
              setLang(l.code);
            }}
            className={`focus-ring h-10 rounded-full px-4 text-label ${l.code === lang ? "bg-fg text-canvas" : "bg-surface-2 text-fg hover:bg-surface-3"}`}
            aria-pressed={l.code === lang}
          >
            {l.label}
          </button>
        ))}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon="lightbulb" onClick={() => (resetHints(), toast(t("settingsx.language.hintsBack")))}>
          {t("settingsx.language.showHints")}
        </Button>
      </div>
    </Card>
  );
}

/** Personal API tokens for scripts (see /docs). */
export function ApiTokens() {
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api<APIToken[]>("/api/tokens") });
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const create = async () => {
    try {
      const r = await api<{ token: string }>("/api/tokens", { method: "POST", json: { kind: "api", name: name.trim() } });
      setFresh(r.token);
      setName("");
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const revoke = async (id: string) => {
    await api(`/api/tokens/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: ["tokens"] });
    toast(t("settingsx.api.revoked"));
  };
  const list = (tokens.data ?? []).filter((x) => x.kind === "api");
  return (
    <Card title={t("settingsx.api.title")} icon="code" tip={t("settingsx.api.tip")}>
      <div className="flex flex-col gap-3 py-4">
        <div className="flex gap-2">
          <input className="input h-11 min-w-0 flex-1" placeholder={t("settingsx.api.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <Button icon="key" onClick={create}>
            {t("settingsx.api.create")}
          </Button>
        </div>
        {fresh && (
          <div className="rounded-control bg-accent-soft p-3 text-body-sm">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="alert" size={16} className="text-accent" />
              {t("settingsx.api.onlyOnce")}
            </div>
            <div className="flex items-center gap-2 rounded-control bg-surface-2 p-2">
              <code className="min-w-0 flex-1 break-all font-mono text-caption">{fresh}</code>
              <Button size="sm" icon="clipboard" onClick={() => copy(fresh)} aria-label={t("common.copy")} />
            </div>
          </div>
        )}
        {list.map((tk) => (
          <div key={tk.id} className="flex items-center gap-3 text-body-sm">
            <Icon name="key" size={18} className="text-fg-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate">{tk.name || t("settingsx.api.unnamed")}</div>
              <div className="truncate text-caption text-fg-muted">
                <code className="font-mono">{tk.prefix}…</code> · {t("settingsx.api.created", { ago: fmtAgo(tk.createdAt) })} ·{" "}
                {tk.lastUsedAt ? t("settingsx.api.used", { ago: fmtAgo(tk.lastUsedAt) }) : t("settingsx.api.neverUsed")}
              </div>
            </div>
            <Button size="sm" variant="danger" onClick={() => revoke(tk.id)}>
              {t("settingsx.api.revoke")}
            </Button>
          </div>
        ))}
        <a href="/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-label text-accent hover:underline">
          <Icon name="code" size={16} /> {t("settingsx.api.docs")}
        </a>
      </div>
    </Card>
  );
}

type DiscordInfo = { configured: boolean; agentUrl: string; server: string; downloads: { os: string; file: string; url: string; size: number }[] };

/** Discord presence: download the small agent, run one command on the computer with Discord. */
export function DiscordPresence() {
  const settings = useSettings();
  const info = useQuery({ queryKey: ["discordInfo"], queryFn: () => api<DiscordInfo>("/api/discord") });
  const [token, setToken] = useState<string | null>(null);
  const on = !!settings.data?.discordPresence;
  const d = info.data;
  if (!d) return null;
  const guess = /Windows/i.test(navigator.userAgent) ? "windows" : /Mac/i.test(navigator.userAgent) ? "macos-arm64" : "linux";
  const mine = d.downloads.find((x) => x.os === guess) ?? d.downloads[0];
  const exe = mine?.file ?? (guess === "windows" ? "vang.exe" : "./vang");
  const run = guess === "windows" ? `.\\${exe}` : `chmod +x ${exe} && ./${exe}`;
  const cmd = token ? `${run} discord-agent -server ${d.server} -token ${token}` : "";
  const newToken = async () => {
    const r = await api<{ token: string }>("/api/tokens", { method: "POST", json: { kind: "agent" } });
    setToken(r.token);
  };
  return (
    <Card title={t("settingsx.discord.title")} icon="headphones" tip={t("settingsx.discord.tip")}>
      {!d.configured ? (
        <p className="py-4 text-body-sm text-fg-muted">{t("settingsx.discord.notConfigured")}</p>
      ) : (
        <>
          <div className="flex items-center gap-4 py-4">
            <div className="min-w-0 flex-1">
              <div className="text-body">{t("settingsx.discord.toggle")}</div>
              <div className="text-body-sm text-fg-muted">{t("settingsx.discord.toggleHint")}</div>
            </div>
            <button
              role="switch"
              aria-checked={on}
              aria-label={t("settingsx.discord.toggle")}
              onClick={() => saveSettings({ discordPresence: !on }).then(() => notify({ text: t(on ? "settingsx.discord.off" : "settingsx.discord.on"), icon: "headphones" }))}
              className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors duration-fast ${on ? "bg-accent" : "bg-surface-4"}`}
            >
              <span className={`absolute top-1 size-5 rounded-full bg-fg transition-[left] duration-fast ${on ? "left-6 !bg-fg-on-accent" : "left-1"}`} />
            </button>
          </div>
          {on && (
            <ol className="flex list-decimal flex-col gap-4 py-4 pl-5 text-body-sm">
              <li>
                {t("settingsx.discord.step1")}
                <div className="mt-2 flex flex-wrap gap-2">
                  {d.downloads.map((x) => (
                    <a key={x.file} href={x.url} download className={`focus-ring inline-flex h-9 items-center gap-2 rounded-control px-3 text-label ${x === mine ? "bg-accent text-fg-on-accent" : "bg-surface-2"}`}>
                      <Icon name="download" size={16} /> {t(`settingsx.discord.os.${x.os}`)} · {fmtBytes(x.size)}
                    </a>
                  ))}
                  {d.agentUrl && (
                    <a href={d.agentUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex h-9 items-center gap-2 rounded-control bg-surface-2 px-3 text-label">
                      <Icon name="download" size={16} /> {t("settingsx.discord.otherDownloads")}
                    </a>
                  )}
                  {!d.downloads.length && !d.agentUrl && <span className="text-fg-muted">{t("settingsx.discord.noDownloads")}</span>}
                </div>
              </li>
              <li>
                {t("settingsx.discord.step2")}
                <div className="mt-2">
                  <Button size="sm" icon="key" onClick={newToken}>
                    {t("settingsx.discord.makeToken")}
                  </Button>
                </div>
              </li>
              {cmd && (
                <li>
                  {t("settingsx.discord.step3")}
                  <div className="mt-2 flex items-center gap-2 rounded-control bg-surface-2 p-2">
                    <code className="min-w-0 flex-1 break-all font-mono text-caption">{cmd}</code>
                    <Button size="sm" icon="clipboard" onClick={() => copy(cmd)} aria-label={t("common.copy")} />
                  </div>
                  <p className="mt-1 text-caption text-fg-muted">{t("settingsx.discord.keepRunning")}</p>
                </li>
              )}
            </ol>
          )}
        </>
      )}
    </Card>
  );
}
