import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type AdminUser, type HistoryItem, type Job, type Role, type ServerSettings, type Stats, type Track } from "@/lib/api";
import { queryClient, useMe } from "@/lib/queries";
import { fmtAgo, fmtBytes, fmtMs } from "@/lib/format";
import { locale, t, tn, tsv } from "@/i18n";
import { Avatar, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Cover } from "@/components/ui/Cover";
import { Empty, ErrorState, Spinner } from "@/components/ui/misc";
import { toast } from "@/components/ui/Toast";
import { BrandingCard, DiscordCard, LimitsCard, LogsPanel, TagsCard } from "./AdminExtra";

type UsersResp = { users: AdminUser[]; defaultStorageMb: number; mailConfigured: boolean };
type System = {
  ytdlp: { ready: boolean; error: string; version: string; bin: string; managed: boolean; jsRuntime: string };
  ffmpeg: string;
  storage: { musicBytes: number; musicFiles: number; coverBytes: number; dbBytes: number; tracks: number; trackBytes: number; orphanTracks: number };
  analysis: { loudnessPending: number; featuresPending: number; featuresReady: number };
  jobs: Record<string, number>;
  users: { total: number; admins: number; online: number };
  mail: { configured: boolean; host: string; from: string };
  recs: { provider: string };
  autoNext: number;
  publicUrl: string;
  go: string;
  dataDir: string;
};

const LIMITS_GB = [0.5, 1, 2, 5, 10, 20, 50, 100];
const gb = (mb: number) => `${(mb / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 })} GB`;

const useUsers = () => useQuery({ queryKey: ["admin", "users"], queryFn: () => api<UsersResp>("/api/admin/users"), refetchInterval: 30_000 });

async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) toast(ok, "success");
    queryClient.invalidateQueries({ queryKey: ["admin"] });
    return r;
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export function AdminPage() {
  const me = useMe();
  const { tab = "users", user } = useSearch({ from: "/admin" });
  const navigate = useNavigate({ from: "/admin" });
  if (me.data && me.data.user.role !== "admin") return <Empty icon="lock" title={t("admin.accessDenied")} />;
  const setTab = (t: "users" | "system") => navigate({ search: { tab: t === "users" ? undefined : t }, replace: true });
  return (
    <div>
      <PageHeader title={t("common.nav.admin")}>
        <div role="tablist" className="mt-4 flex gap-2">
          {(
            [
              ["users", t("admin.tabs.users"), "users"],
              ["system", t("admin.tabs.system"), "settings"],
            ] as const
          ).map(([k, label, icon]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`focus-ring flex h-9 items-center gap-2 rounded-full px-4 text-label transition-colors duration-fast ${tab === k ? "bg-fg text-canvas" : "bg-surface-2 text-fg state-layer"}`}
            >
              <Icon name={icon} size={18} />
              {label}
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="px-4 md:px-6">{tab === "system" ? <SystemTab /> : user ? <UserDetail id={user} /> : <UsersTab />}</div>
    </div>
  );
}

// ── users ───────────────────────────────────────────────────────────────

function UsersTab() {
  const { data, isLoading, error, refetch } = useUsers();
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate({ from: "/admin" });
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body-sm text-fg-muted">
          {tn("admin.users.accounts", data.users.length)} · {t("admin.users.onlineCount", { n: data.users.filter((u) => u.online).length })}
        </p>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
          {t("admin.users.add")}
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {data.users.map((u) => (
          <li key={u.id}>
            <button
              onClick={() => navigate({ search: { user: u.id } })}
              className="focus-ring state-layer flex w-full items-center gap-3 rounded-card bg-surface-1 p-3 text-left md:p-4"
            >
              <span className="relative">
                <Avatar name={u.name || u.email} size={44} />
                {u.online && <span className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 border-surface-1 bg-success" title={t("admin.users.online")} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-body">{u.name || u.email}</span>
                  {u.role === "admin" && <Badge tone="accent">{t("admin.role.admin")}</Badge>}
                  {u.disabled && <Badge tone="danger">{t("admin.users.disabled")}</Badge>}
                </span>
                <span className="block truncate text-caption text-fg-muted">
                  {u.name ? u.email + " · " : ""}
                  {tn("common.songs", u.tracks)} · {tn("admin.users.plays30d", u.plays30d)} ·{" "}
                  {u.lastListenAt ? t("admin.users.lastListened", { ago: fmtAgo(u.lastListenAt) }) : t("admin.users.neverListened")}
                  {u.autoDownload ? ` · ${t("admin.users.autoDownloadTag")}` : ""}
                </span>
              </span>
              <Usage used={u.usedBytes} limitMb={u.storageLimitMb} className="hidden w-40 md:flex" />
              <Icon name="chevron-right" size={20} className="text-fg-muted" />
            </button>
          </li>
        ))}
      </ul>
      {adding && <AddUserDialog defaultMb={data.defaultStorageMb} mail={data.mailConfigured} onClose={() => setAdding(false)} />}
    </div>
  );
}

function Badge({ tone, children }: { tone: "accent" | "danger" | "muted"; children: React.ReactNode }) {
  const cls = tone === "accent" ? "bg-accent-soft text-accent" : tone === "danger" ? "bg-surface-3 text-danger" : "bg-surface-3 text-fg-muted";
  return <span className={`shrink-0 rounded-xs px-1.5 text-caption ${cls}`}>{children}</span>;
}

function Usage({ used, limitMb, className = "" }: { used: number; limitMb: number; className?: string }) {
  const limit = limitMb * 1024 * 1024;
  const pct = Math.min(100, (used / limit) * 100);
  return (
    <span className={`flex-col gap-1 ${className}`}>
      <span className="text-right text-caption text-fg-muted">
        {fmtBytes(used)} / {gb(limitMb)}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <span className={`block h-full rounded-full ${pct >= 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function LimitSelect({ mb, onChange }: { mb: number; onChange: (mb: number) => void }) {
  const opts = [...new Set([...LIMITS_GB.map((g) => Math.round(g * 1024)), mb])].sort((a, b) => a - b);
  return (
    <select className="input h-11" value={mb} onChange={(e) => onChange(+e.target.value)} aria-label={t("admin.users.storageLimit")}>
      {opts.map((m) => (
        <option key={m} value={m}>
          {gb(m)}
        </option>
      ))}
    </select>
  );
}

function AddUserDialog({ defaultMb, mail, onClose }: { defaultMb: number; mail: boolean; onClose: () => void }) {
  const [f, setF] = useState({ email: "", name: "", role: "listener" as Role, storageLimitMb: defaultMb, password: "", sendInvite: mail });
  const create = useMutation({
    mutationFn: () => api<AdminUser>("/api/admin/users", { method: "POST", json: f }),
    onSuccess: (u) => {
      toast(u.note ? tsv(u.note) : t(f.sendInvite ? "admin.addUser.createdInvited" : "admin.addUser.created", { email: u.email }), u.note ? "error" : "success");
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      onClose();
    },
  });
  const needPw = !mail;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("admin.users.add")}
      description={t(mail ? "admin.addUser.descMail" : "admin.addUser.descNoMail")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!f.email || (needPw && f.password.length < 8)} onClick={() => create.mutate()}>
            {t("admin.addUser.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <input className="input h-11" type="email" placeholder={t("admin.addUser.emailPlaceholder")} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoFocus />
        <input className="input h-11" placeholder={t("admin.addUser.namePlaceholder")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <select className="input h-11" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })} aria-label={t("admin.users.role")}>
            <option value="listener">{t("admin.role.listener")}</option>
            <option value="admin">{t("admin.role.admin")}</option>
          </select>
          <LimitSelect mb={f.storageLimitMb} onChange={(mb) => setF({ ...f, storageLimitMb: mb })} />
        </div>
        <input
          className="input h-11"
          type="password"
          autoComplete="new-password"
          placeholder={t(needPw ? "admin.addUser.pwRequired" : "admin.addUser.pwOptional")}
          value={f.password}
          onChange={(e) => setF({ ...f, password: e.target.value })}
        />
        {mail && (
          <label className="flex items-center gap-2 text-body-sm">
            <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={f.sendInvite} onChange={(e) => setF({ ...f, sendInvite: e.target.checked })} />
            {t("admin.addUser.sendInvite")}
          </label>
        )}
        {create.error && (
          <p role="alert" className="text-body-sm text-danger">
            {(create.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function UserDetail({ id }: { id: string }) {
  const navigate = useNavigate({ from: "/admin" });
  const me = useMe().data?.user;
  const [days, setDays] = useState(30);
  const stats = useQuery({
    queryKey: ["admin", "user", id, "stats", days],
    queryFn: () => api<Stats & { user: AdminUser }>(`/api/admin/users/${id}/stats?days=${days}&tz=${new Date().getTimezoneOffset()}`),
  });
  const history = useQuery({ queryKey: ["admin", "user", id, "history"], queryFn: () => api<HistoryItem[]>(`/api/admin/users/${id}/history?limit=30`) });
  const tracks = useQuery({ queryKey: ["admin", "user", id, "tracks"], queryFn: () => api<Track[]>(`/api/admin/users/${id}/tracks`) });
  const [confirm, setConfirm] = useState<null | "history" | "all" | "delete">(null);
  const [pw, setPw] = useState("");
  const [showAll, setShowAll] = useState(false);
  const back = () => navigate({ search: {} });

  if (stats.isLoading) return <Spinner />;
  if (stats.error || !stats.data) return <ErrorState error={stats.error} onRetry={stats.refetch} />;
  const s = stats.data;
  const u = s.user;
  const self = me?.id === u.id;
  const patch = (body: object, ok: string) => act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", json: body }), ok);
  const lib = tracks.data ?? [];

  return (
    <div className="flex flex-col gap-6 pb-8">
      <button onClick={back} className="focus-ring -ml-2 flex h-10 w-fit items-center gap-1 rounded-control px-2 text-label text-fg-muted hover:text-fg">
        <Icon name="chevron-left" size={20} /> {t("admin.user.allUsers")}
      </button>

      <section className="flex flex-wrap items-center gap-4 rounded-card bg-surface-1 p-4">
        <Avatar name={u.name || u.email} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-title-3">{u.name || u.email}</h2>
            {u.role === "admin" && <Badge tone="accent">{t("admin.role.admin")}</Badge>}
            {u.disabled && <Badge tone="danger">{t("admin.users.disabled")}</Badge>}
            {u.online && <Badge tone="muted">{t("admin.users.online")}</Badge>}
          </div>
          <p className="truncate text-body-sm text-fg-muted">
            {u.email} · {t("admin.user.created", { ago: fmtAgo(u.createdAt) })} ·{" "}
            {u.lastLoginAt ? t("admin.user.lastLogin", { ago: fmtAgo(u.lastLoginAt) }) : t("admin.user.neverLoggedIn")} ·{" "}
            {t(u.hasPassword ? "admin.user.hasPassword" : "admin.user.codeOnly")}
          </p>
        </div>
        <Usage used={u.usedBytes} limitMb={u.storageLimitMb} className="flex w-full md:w-56" />
      </section>

      {/* habits */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-title-3">{t("admin.user.habits")}</h3>
          <select className="input h-9 w-auto" value={days} onChange={(e) => setDays(+e.target.value)} aria-label={t("admin.user.timeRange")}>
            <option value={7}>{t("admin.user.days7")}</option>
            <option value={30}>{t("admin.user.days30")}</option>
            <option value={365}>{t("admin.user.year1")}</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label={t("admin.user.minutes")} value={s.totalMinutes.toLocaleString(locale())} />
          <Stat label={t("admin.user.plays")} value={s.plays.toLocaleString(locale())} />
          <Stat label={t("admin.user.skips")} value={s.skips.toLocaleString(locale())} />
          <Stat label={t("admin.user.libraryCount")} value={s.libraryCount.toLocaleString(locale())} />
        </div>
        <HourBars hours={s.hours} />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-card bg-surface-1 p-4">
            <h4 className="mb-2 text-label text-fg-muted">{t("admin.user.topArtists")}</h4>
            {s.topArtists.length ? (
              <ol className="flex flex-col gap-1.5">
                {s.topArtists.map((a, i) => (
                  <li key={a.name} className="flex items-center gap-2 text-body-sm">
                    <span className="w-5 text-right text-fg-muted tabular">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="text-fg-muted tabular">{a.plays}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-body-sm text-fg-muted">{t("admin.user.noPlays")}</p>
            )}
          </div>
          <div className="rounded-card bg-surface-1 p-4">
            <h4 className="mb-2 text-label text-fg-muted">{t("admin.user.topTracks")}</h4>
            {s.topTracks.length ? (
              <ol className="flex flex-col gap-1.5">
                {s.topTracks.slice(0, 10).map((tr) => (
                  <li key={tr.id} className="flex items-center gap-2 text-body-sm">
                    <Cover trackId={tr.id} hasCover={tr.hasCover} size={28} />
                    <span className="min-w-0 flex-1 truncate">
                      {tr.title} <span className="text-fg-muted">· {tr.artist}</span>
                    </span>
                    <span className="text-fg-muted tabular">{tr.plays}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-body-sm text-fg-muted">{t("admin.user.noPlays")}</p>
            )}
          </div>
        </div>
        <div className="rounded-card bg-surface-1 p-4">
          <h4 className="mb-2 text-label text-fg-muted">{t("admin.user.recent")}</h4>
          {history.data?.length ? (
            <ul className="flex flex-col gap-1.5">
              {history.data.slice(0, 15).map((h, i) => (
                <li key={i} className="flex items-center gap-2 text-body-sm">
                  <span className="w-24 shrink-0 text-caption text-fg-muted">{fmtAgo(h.startedAt)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {h.track.title} <span className="text-fg-muted">· {h.track.artist}</span>
                  </span>
                  <span className="text-caption text-fg-muted">
                    {h.action === "skip" ? t("admin.user.actionSkip") : h.action === "repeat" ? t("admin.user.actionRepeat") : fmtMs(h.playedMs)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body-sm text-fg-muted">{t("admin.user.none")}</p>
          )}
        </div>
      </section>

      {/* library */}
      <section className="flex flex-col gap-2">
        <h3 className="text-title-3">{t("admin.user.libraryTitle", { count: tn("common.songs", lib.length) })}</h3>
        <ul className="flex flex-col rounded-card bg-surface-1 p-2">
          {(showAll ? lib : lib.slice(0, 12)).map((tr) => (
            <li key={tr.id} className="flex items-center gap-3 rounded-control px-2 py-1.5 hover:bg-surface-2">
              <Cover trackId={tr.id} hasCover={tr.hasCover} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm">{tr.title}</span>
                <span className="block truncate text-caption text-fg-muted">
                  {tr.artist} · {tn("admin.user.trackPlays", tr.playCount)} · {t("admin.user.trackAdded", { ago: fmtAgo(tr.addedAt) })}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label={t("admin.user.removeTrackAria", { title: tr.title, email: u.email })}
                onClick={() => act(() => api(`/api/admin/users/${u.id}/tracks/${tr.id}`, { method: "DELETE" }), t("admin.user.trackRemoved"))}
              />
            </li>
          ))}
          {!lib.length && <li className="p-3 text-body-sm text-fg-muted">{t("admin.user.libraryEmpty")}</li>}
          {lib.length > 12 && !showAll && (
            <li>
              <button className="focus-ring state-layer h-10 w-full rounded-control text-label text-fg-muted" onClick={() => setShowAll(true)}>
                {tn("admin.user.showAllTracks", lib.length)}
              </button>
            </li>
          )}
        </ul>
      </section>

      {/* manage */}
      <section className="flex flex-col gap-3 rounded-card bg-surface-1 p-4">
        <h3 className="text-title-3">{t("admin.user.manage")}</h3>
        <Line label={t("admin.users.role")} hint={t(self ? "admin.user.roleHintSelf" : "admin.user.roleHint")}>
          <select className="input h-11" value={u.role} disabled={self} onChange={(e) => patch({ role: e.target.value }, t("admin.user.roleChanged"))} aria-label={t("admin.users.role")}>
            <option value="listener">{t("admin.role.listener")}</option>
            <option value="admin">{t("admin.role.admin")}</option>
          </select>
        </Line>
        <Line label={t("admin.users.storageLimit")} hint={t("admin.user.storageLimitHint")}>
          <LimitSelect mb={u.storageLimitMb} onChange={(mb) => patch({ storageLimitMb: mb }, t("admin.user.limitChanged"))} />
        </Line>
        <Line label={t("admin.user.setPassword")} hint={t("admin.user.setPasswordHint")}>
          <div className="flex gap-2">
            <input className="input h-11 min-w-0 flex-1" type="password" autoComplete="new-password" placeholder={t("admin.user.pwPlaceholder")} value={pw} onChange={(e) => setPw(e.target.value)} />
            <Button disabled={pw.length < 8} onClick={() => patch({ password: pw }, t("admin.user.pwSet")).then(() => setPw(""))}>
              {t("admin.user.setBtn")}
            </Button>
          </div>
        </Line>
        {!self && (
          <div className="flex flex-wrap gap-2 pt-2">
            <Button icon="logout" onClick={() => patch({ signOut: true }, t("admin.user.signedOutAll"))}>
              {t("admin.user.signOutAll")}
            </Button>
            <Button variant={u.disabled ? "secondary" : "danger"} icon="lock" onClick={() => patch({ disabled: !u.disabled }, t(u.disabled ? "admin.user.unlocked" : "admin.user.locked"))}>
              {t(u.disabled ? "admin.user.unlock" : "admin.user.lock")}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={() => setConfirm("history")}>
            {t("admin.user.clearHistory")}
          </Button>
          <Button variant="danger" onClick={() => setConfirm("all")}>
            {t("admin.user.clearAll")}
          </Button>
          {!self && (
            <Button variant="danger" icon="trash" onClick={() => setConfirm("delete")}>
              {t("admin.user.deleteAccount")}
            </Button>
          )}
        </div>
      </section>

      {confirm && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={
            confirm === "delete"
              ? t("admin.user.confirmDeleteTitle", { email: u.email })
              : t(confirm === "all" ? "admin.user.confirmAllTitle" : "admin.user.confirmHistoryTitle")
          }
          description={t(confirm === "delete" ? "admin.user.confirmDeleteDesc" : confirm === "all" ? "admin.user.confirmAllDesc" : "admin.user.confirmHistoryDesc")}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={async () => {
                  const c = confirm;
                  setConfirm(null);
                  if (c === "delete") {
                    const r = await act(() => api<{ filesFreed: number }>(`/api/admin/users/${u.id}`, { method: "DELETE" }));
                    if (r) {
                      toast(tn("admin.user.accountDeleted", r.filesFreed), "success");
                      back();
                    }
                  } else {
                    await act(() => api(`/api/admin/users/${u.id}/reset`, { method: "POST", json: { scope: c } }), t("admin.user.deleted"));
                  }
                }}
              >
                {t("common.delete")}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card bg-surface-1 p-4">
      <div className="text-title-2 tabular">{value}</div>
      <div className="text-caption text-fg-muted">{label}</div>
    </div>
  );
}

/** Listens by hour of day. */
function HourBars({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours);
  return (
    <div className="rounded-card bg-surface-1 p-4">
      <h4 className="mb-2 text-label text-fg-muted">{t("admin.hours.title")}</h4>
      <div className="flex h-20 items-end gap-0.5" role="img" aria-label={t("admin.hours.aria", { hour: hours.indexOf(Math.max(...hours)) })}>
        {hours.map((n, h) => (
          <div key={h} className="flex flex-1 flex-col items-center justify-end gap-1" title={tn("admin.hours.barTitle", n, { hour: h })}>
            <div className="w-full rounded-t-xs bg-accent" style={{ height: `${(n / max) * 100}%`, minHeight: n ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-caption text-fg-subtle tabular">
        <span>0h</span>
        <span>6h</span>
        <span>12h</span>
        <span>18h</span>
        <span>23h</span>
      </div>
    </div>
  );
}

function Line({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-body">{label}</div>
        {hint && <div className="text-body-sm text-fg-muted">{hint}</div>}
      </div>
      <div className="md:w-72">{children}</div>
    </div>
  );
}

// ── system ──────────────────────────────────────────────────────────────

function SystemTab() {
  const sys = useQuery({ queryKey: ["admin", "system"], queryFn: () => api<System>("/api/admin/system"), refetchInterval: 15_000 });
  const jobs = useQuery({ queryKey: ["admin", "jobs"], queryFn: () => api<{ jobs: (Job & { email: string })[] }>("/api/admin/jobs"), refetchInterval: 5_000 });
  const srv = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api<ServerSettings>("/api/admin/settings") });
  const [busy, setBusy] = useState("");
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy("");
    }
  };
  if (sys.isLoading) return <Spinner />;
  if (sys.error || !sys.data) return <ErrorState error={sys.error} onRetry={sys.refetch} />;
  const d = sys.data;
  const active = (d.jobs.queued ?? 0) + (d.jobs.downloading ?? 0) + (d.jobs.processing ?? 0);
  return (
    <div className="grid gap-4 pb-8 md:grid-cols-2">
      <Card title="yt-dlp" icon="download" status={d.ytdlp.ready ? "ok" : "bad"}>
        <KV k={t("admin.sys.ytdlp.version")} v={d.ytdlp.version || (d.ytdlp.ready ? "?" : t("admin.sys.ytdlp.notReady"))} />
        <KV k={t("admin.sys.ytdlp.managed")} v={t(d.ytdlp.managed ? "admin.sys.ytdlp.autoUpdate" : "admin.sys.ytdlp.external")} />
        <KV k="JS runtime" v={d.ytdlp.jsRuntime || t("admin.sys.ytdlp.none")} />
        <KV k="ffmpeg" v={d.ffmpeg} mono />
        {d.ytdlp.error && <p className="text-body-sm text-danger">{tsv(d.ytdlp.error)}</p>}
        <Button
          icon="retry"
          loading={busy === "yt"}
          disabled={!d.ytdlp.managed}
          onClick={() => run("yt", () => act(() => api<{ version: string }>("/api/admin/system/ytdlp-update", { method: "POST" }), t("admin.sys.ytdlp.updated")))}
        >
          {t("admin.sys.ytdlp.updateNow")}
        </Button>
      </Card>

      <Card title={t("admin.sys.storage.title")} icon="library">
        <KV k={t("admin.sys.storage.music")} v={tn("admin.sys.storage.musicVal", d.storage.musicFiles, { size: fmtBytes(d.storage.musicBytes) })} />
        <KV k={t("admin.sys.storage.covers")} v={fmtBytes(d.storage.coverBytes)} />
        <KV k={t("admin.sys.storage.db")} v={fmtBytes(d.storage.dbBytes)} />
        <KV k={t("admin.sys.storage.tracks")} v={t("admin.sys.storage.tracksVal", { n: d.storage.tracks.toLocaleString(locale()) })} />
        <KV k={t("admin.sys.storage.orphans")} v={d.storage.orphanTracks.toLocaleString(locale())} />
        <KV k={t("admin.sys.storage.dataDir")} v={d.dataDir} mono />
        <Button
          icon="trash"
          loading={busy === "clean"}
          onClick={() =>
            run("clean", async () => {
              const r = await act(() => api<{ orphanTracks: number; strayFiles: number; strayBytes: number; oldJobs: number }>("/api/admin/system/cleanup", { method: "POST" }));
              if (r) {
                toast(t("admin.sys.storage.cleaned", { orphans: r.orphanTracks, files: r.strayFiles, size: fmtBytes(r.strayBytes), jobs: r.oldJobs }), "success");
              }
            })
          }
        >
          {t("admin.sys.storage.cleanup")}
        </Button>
      </Card>

      <Card title={t("admin.sys.analysis.title")} icon="stats">
        <KV k={t("admin.sys.analysis.loudness")} v={d.analysis.loudnessPending.toLocaleString(locale())} />
        <KV
          k={t("admin.sys.analysis.features")}
          v={t("admin.sys.analysis.featuresVal", { ready: d.analysis.featuresReady.toLocaleString(locale()), pending: d.analysis.featuresPending.toLocaleString(locale()) })}
        />
        <KV k={t("admin.sys.analysis.similarSource")} v={d.recs.provider === "lastfm" ? "Last.fm" : "Deezer"} />
        <KV k={t("admin.sys.analysis.autoNext")} v={d.autoNext ? new Date(d.autoNext).toLocaleString(locale()) : "—"} />
        <Button
          icon="retry"
          loading={busy === "cache"}
          onClick={() =>
            run("cache", async () => {
              const r = await act(() => api<{ removed: number }>("/api/admin/system/clear-cache", { method: "POST" }));
              if (r) toast(tn("admin.sys.analysis.cacheCleared", r.removed), "success");
            })
          }
        >
          {t("admin.sys.analysis.clearCache")}
        </Button>
      </Card>

      <Card title={t("admin.sys.mail.title")} icon="mail" status={d.mail.configured ? "ok" : "warn"}>
        <KV k={t("admin.sys.mail.status")} v={t(d.mail.configured ? "admin.sys.mail.configured" : "admin.sys.mail.notConfigured")} />
        <KV k={t("admin.sys.mail.smtpHost")} v={d.mail.host} />
        <KV k={t("admin.sys.mail.from")} v={d.mail.from || "—"} />
        <KV k={t("admin.sys.mail.publicUrl")} v={d.publicUrl || t("admin.sys.mail.noPublicUrl")} />
        <p className="text-caption text-fg-muted">{t("admin.sys.mail.envNote")}</p>
        <Button
          icon="mail"
          loading={busy === "mail"}
          disabled={!d.mail.configured}
          onClick={() =>
            run("mail", async () => {
              const r = await act(() => api<{ to: string }>("/api/admin/system/test-mail", { method: "POST" }));
              if (r) toast(t("admin.sys.mail.testSent", { to: r.to }), "success");
            })
          }
        >
          {t("admin.sys.mail.sendTest")}
        </Button>
      </Card>

      <Card title={t("admin.sys.format.title")} icon="music-note">
        <p className="text-body-sm text-fg-muted">{t("admin.sys.format.note")}</p>
        {srv.data && (
          <div className="grid grid-cols-2 gap-3">
            <select
              className="input h-11"
              value={srv.data.audioFormat}
              aria-label={t("admin.sys.format.formatAria")}
              onChange={(e) => act(() => api("/api/admin/settings", { method: "PUT", json: { ...srv.data, audioFormat: e.target.value } }), t("common.saved"))}
            >
              <option value="m4a">m4a</option>
              <option value="opus">opus</option>
            </select>
            <select
              className="input h-11"
              value={srv.data.bitrate}
              aria-label={t("admin.sys.format.bitrateAria")}
              onChange={(e) => act(() => api("/api/admin/settings", { method: "PUT", json: { ...srv.data, bitrate: +e.target.value } }), t("common.saved"))}
            >
              {[128, 160, 192, 256, 320].map((b) => (
                <option key={b} value={b}>
                  {b} kbps
                </option>
              ))}
            </select>
          </div>
        )}
      </Card>

      <Card title={t("admin.tabs.users")} icon="users">
        <KV k={t("admin.sys.users.accounts")} v={tn("admin.sys.users.accountsVal", d.users.admins, { total: d.users.total.toLocaleString(locale()) })} />
        <KV k={t("admin.users.online")} v={d.users.online.toLocaleString(locale())} />
        <KV k="Go" v={d.go} />
      </Card>

      <BrandingCard />
      <DiscordCard />
      <LimitsCard />
      <TagsCard />
      <LogsPanel />

      <section className="rounded-card bg-surface-1 p-4 md:col-span-2">
        <h3 className="mb-2 flex items-center gap-2 text-title-3">
          <Icon name="download" size={20} className="text-accent" />
          {t("admin.sys.jobs.title")}
          <span className="text-body-sm font-normal text-fg-muted">· {t("admin.sys.jobs.summary", { active, failed: d.jobs.error ?? 0 })}</span>
        </h3>
        {jobs.data?.jobs.length ? (
          <ul className="flex flex-col">
            {jobs.data.jobs.map((j) => (
              <li key={j.id} className="flex items-center gap-3 border-t border-line py-2 first:border-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm">{j.title ? tsv(j.title) : j.url}</span>
                  <span className={`block truncate text-caption ${j.status === "error" ? "text-danger" : "text-fg-muted"}`}>
                    {j.email} · {j.status === "error" ? tsv(j.error) : tsv(j.stage || j.status)}
                    {j.status === "downloading" && j.progress > 0 ? ` ${Math.round(j.progress * 100)}%` : ""}
                  </span>
                </span>
                {j.status === "error" && (
                  <Button size="sm" icon="retry" aria-label={t("common.retry")} onClick={() => act(() => api(`/api/downloads/${j.id}/retry`, { method: "POST" }))} />
                )}
                <Button size="sm" variant="ghost" icon="close" aria-label={t("admin.sys.jobs.cancelAria")} onClick={() => act(() => api(`/api/downloads/${j.id}`, { method: "DELETE" }))} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-fg-muted">{t("admin.sys.jobs.empty")}</p>
        )}
      </section>
    </div>
  );
}

function Card({ title, icon, status, children }: { title: string; icon: IconName; status?: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-card bg-surface-1 p-4">
      <h3 className="flex items-center gap-2 text-title-3">
        <Icon name={icon} size={20} className="text-accent" />
        <span className="flex-1">{title}</span>
        {status && (
          <span
            className={`size-2.5 rounded-full ${status === "ok" ? "bg-success" : status === "warn" ? "bg-warning" : "bg-danger"}`}
            aria-label={t(status === "ok" ? "admin.sys.statusOk" : "admin.sys.statusCheck")}
          />
        )}
      </h3>
      {children}
    </section>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 text-body-sm">
      <span className="w-40 shrink-0 text-fg-muted">{k}</span>
      <span className={`min-w-0 flex-1 break-all ${mono ? "font-mono text-caption" : ""}`}>{v}</span>
    </div>
  );
}
