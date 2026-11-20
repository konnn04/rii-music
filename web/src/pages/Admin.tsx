import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type AdminUser, type HistoryItem, type Job, type Role, type ServerSettings, type Stats, type Track } from "@/lib/api";
import { queryClient, useMe } from "@/lib/queries";
import { fmtAgo, fmtBytes, fmtMs } from "@/lib/format";
import { Avatar, PageHeader } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Cover } from "@/components/ui/Cover";
import { Empty, ErrorState, Spinner } from "@/components/ui/misc";
import { toast } from "@/components/ui/Toast";
import { BrandingCard, DiscordCard, LogsPanel } from "./AdminExtra";

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
const gb = (mb: number) => `${(mb / 1024).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} GB`;

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
  if (me.data && me.data.user.role !== "admin") return <Empty icon="lock" title="Chỉ admin mới vào được trang này" />;
  const setTab = (t: "users" | "system") => navigate({ search: { tab: t === "users" ? undefined : t }, replace: true });
  return (
    <div>
      <PageHeader title="Quản trị">
        <div role="tablist" className="mt-4 flex gap-2">
          {(
            [
              ["users", "Người dùng", "users"],
              ["system", "Hệ thống", "settings"],
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
          {data.users.length} tài khoản · {data.users.filter((u) => u.online).length} đang mở app
        </p>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
          Thêm người dùng
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
                {u.online && <span className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 border-surface-1 bg-success" title="Đang mở app" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-body">{u.name || u.email}</span>
                  {u.role === "admin" && <Badge tone="accent">Admin</Badge>}
                  {u.disabled && <Badge tone="danger">Đã khoá</Badge>}
                </span>
                <span className="block truncate text-caption text-fg-muted">
                  {u.name ? u.email + " · " : ""}
                  {u.tracks} bài · {u.plays30d} lượt nghe 30 ngày · {u.lastListenAt ? `nghe ${fmtAgo(u.lastListenAt)}` : "chưa nghe"}
                  {u.autoDownload ? " · tự động tải" : ""}
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
    <select className="input h-11" value={mb} onChange={(e) => onChange(+e.target.value)} aria-label="Giới hạn dung lượng">
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
      toast(u.note ?? `Đã tạo tài khoản ${u.email}${f.sendInvite ? ", đã gửi email mời" : ""}`, u.note ? "error" : "success");
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      onClose();
    },
  });
  const needPw = !mail;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Thêm người dùng"
      description={mail ? "Để trống mật khẩu thì người đó đăng nhập bằng mã gửi qua email." : "Máy chủ chưa cấu hình email, cần đặt mật khẩu ban đầu."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!f.email || (needPw && f.password.length < 8)} onClick={() => create.mutate()}>
            Tạo tài khoản
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <input className="input h-11" type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoFocus />
        <input className="input h-11" placeholder="Tên (không bắt buộc)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <select className="input h-11" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })} aria-label="Vai trò">
            <option value="listener">Người nghe</option>
            <option value="admin">Admin</option>
          </select>
          <LimitSelect mb={f.storageLimitMb} onChange={(mb) => setF({ ...f, storageLimitMb: mb })} />
        </div>
        <input
          className="input h-11"
          type="password"
          autoComplete="new-password"
          placeholder={needPw ? "Mật khẩu ban đầu (ít nhất 8 ký tự)" : "Mật khẩu ban đầu (không bắt buộc)"}
          value={f.password}
          onChange={(e) => setF({ ...f, password: e.target.value })}
        />
        {mail && (
          <label className="flex items-center gap-2 text-body-sm">
            <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={f.sendInvite} onChange={(e) => setF({ ...f, sendInvite: e.target.checked })} />
            Gửi email mời (kèm ghi chú admin xem được thói quen nghe)
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
        <Icon name="chevron-left" size={20} /> Tất cả người dùng
      </button>

      <section className="flex flex-wrap items-center gap-4 rounded-card bg-surface-1 p-4">
        <Avatar name={u.name || u.email} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-title-3">{u.name || u.email}</h2>
            {u.role === "admin" && <Badge tone="accent">Admin</Badge>}
            {u.disabled && <Badge tone="danger">Đã khoá</Badge>}
            {u.online && <Badge tone="muted">Đang mở app</Badge>}
          </div>
          <p className="truncate text-body-sm text-fg-muted">
            {u.email} · tạo {fmtAgo(u.createdAt)} · {u.lastLoginAt ? `đăng nhập ${fmtAgo(u.lastLoginAt)}` : "chưa đăng nhập"} · {u.hasPassword ? "có mật khẩu" : "chỉ đăng nhập bằng mã"}
          </p>
        </div>
        <Usage used={u.usedBytes} limitMb={u.storageLimitMb} className="flex w-full md:w-56" />
      </section>

      {/* habits */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-title-3">Thói quen nghe</h3>
          <select className="input h-9 w-auto" value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Khoảng thời gian">
            <option value={7}>7 ngày</option>
            <option value={30}>30 ngày</option>
            <option value={365}>1 năm</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Phút nghe" value={s.totalMinutes.toLocaleString("vi-VN")} />
          <Stat label="Lượt nghe" value={s.plays.toLocaleString("vi-VN")} />
          <Stat label="Bỏ qua" value={s.skips.toLocaleString("vi-VN")} />
          <Stat label="Bài trong thư viện" value={s.libraryCount.toLocaleString("vi-VN")} />
        </div>
        <HourBars hours={s.hours} />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-card bg-surface-1 p-4">
            <h4 className="mb-2 text-label text-fg-muted">Nghệ sĩ nghe nhiều</h4>
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
              <p className="text-body-sm text-fg-muted">Chưa có lượt nghe.</p>
            )}
          </div>
          <div className="rounded-card bg-surface-1 p-4">
            <h4 className="mb-2 text-label text-fg-muted">Bài nghe nhiều</h4>
            {s.topTracks.length ? (
              <ol className="flex flex-col gap-1.5">
                {s.topTracks.slice(0, 10).map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-body-sm">
                    <Cover trackId={t.id} hasCover={t.hasCover} size={28} />
                    <span className="min-w-0 flex-1 truncate">
                      {t.title} <span className="text-fg-muted">· {t.artist}</span>
                    </span>
                    <span className="text-fg-muted tabular">{t.plays}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-body-sm text-fg-muted">Chưa có lượt nghe.</p>
            )}
          </div>
        </div>
        <div className="rounded-card bg-surface-1 p-4">
          <h4 className="mb-2 text-label text-fg-muted">Nghe gần đây</h4>
          {history.data?.length ? (
            <ul className="flex flex-col gap-1.5">
              {history.data.slice(0, 15).map((h, i) => (
                <li key={i} className="flex items-center gap-2 text-body-sm">
                  <span className="w-24 shrink-0 text-caption text-fg-muted">{fmtAgo(h.startedAt)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {h.track.title} <span className="text-fg-muted">· {h.track.artist}</span>
                  </span>
                  <span className="text-caption text-fg-muted">{h.action === "skip" ? "bỏ qua" : h.action === "repeat" ? "nghe lại" : fmtMs(h.playedMs)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body-sm text-fg-muted">Chưa có.</p>
          )}
        </div>
      </section>

      {/* library */}
      <section className="flex flex-col gap-2">
        <h3 className="text-title-3">Thư viện ({lib.length} bài)</h3>
        <ul className="flex flex-col rounded-card bg-surface-1 p-2">
          {(showAll ? lib : lib.slice(0, 12)).map((t) => (
            <li key={t.id} className="flex items-center gap-3 rounded-control px-2 py-1.5 hover:bg-surface-2">
              <Cover trackId={t.id} hasCover={t.hasCover} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm">{t.title}</span>
                <span className="block truncate text-caption text-fg-muted">
                  {t.artist} · {t.playCount} lượt · thêm {fmtAgo(t.addedAt)}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label={`Bỏ ${t.title} khỏi thư viện của ${u.email}`}
                onClick={() => act(() => api(`/api/admin/users/${u.id}/tracks/${t.id}`, { method: "DELETE" }), "Đã bỏ bài khỏi thư viện của người này")}
              />
            </li>
          ))}
          {!lib.length && <li className="p-3 text-body-sm text-fg-muted">Thư viện trống.</li>}
          {lib.length > 12 && !showAll && (
            <li>
              <button className="focus-ring state-layer h-10 w-full rounded-control text-label text-fg-muted" onClick={() => setShowAll(true)}>
                Hiện cả {lib.length} bài
              </button>
            </li>
          )}
        </ul>
      </section>

      {/* manage */}
      <section className="flex flex-col gap-3 rounded-card bg-surface-1 p-4">
        <h3 className="text-title-3">Quản lý</h3>
        <Line label="Vai trò" hint={self ? "Không tự đổi vai trò của chính mình." : "Admin có mọi quyền của người nghe, cộng trang Quản trị."}>
          <select className="input h-11" value={u.role} disabled={self} onChange={(e) => patch({ role: e.target.value }, "Đã đổi vai trò")} aria-label="Vai trò">
            <option value="listener">Người nghe</option>
            <option value="admin">Admin</option>
          </select>
        </Line>
        <Line label="Giới hạn dung lượng" hint="Hạ thấp hơn mức đang dùng: người này không tải thêm được (hoặc tự dọn nếu bật Tự động tải nhạc).">
          <LimitSelect mb={u.storageLimitMb} onChange={(mb) => patch({ storageLimitMb: mb }, "Đã đổi giới hạn")} />
        </Line>
        <Line label="Đặt mật khẩu mới" hint="Người này bị đăng xuất khỏi mọi thiết bị.">
          <div className="flex gap-2">
            <input className="input h-11 min-w-0 flex-1" type="password" autoComplete="new-password" placeholder="Ít nhất 8 ký tự" value={pw} onChange={(e) => setPw(e.target.value)} />
            <Button disabled={pw.length < 8} onClick={() => patch({ password: pw }, "Đã đặt mật khẩu mới").then(() => setPw(""))}>
              Đặt
            </Button>
          </div>
        </Line>
        {!self && (
          <div className="flex flex-wrap gap-2 pt-2">
            <Button icon="logout" onClick={() => patch({ signOut: true }, "Đã đăng xuất người này khỏi mọi thiết bị")}>
              Đăng xuất mọi thiết bị
            </Button>
            <Button variant={u.disabled ? "secondary" : "danger"} icon="lock" onClick={() => patch({ disabled: !u.disabled }, u.disabled ? "Đã mở khoá" : "Đã khoá tài khoản")}>
              {u.disabled ? "Mở khoá" : "Khoá tài khoản"}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={() => setConfirm("history")}>
            Xoá lịch sử nghe
          </Button>
          <Button variant="danger" onClick={() => setConfirm("all")}>
            Xoá toàn bộ dữ liệu
          </Button>
          {!self && (
            <Button variant="danger" icon="trash" onClick={() => setConfirm("delete")}>
              Xoá tài khoản
            </Button>
          )}
        </div>
      </section>

      {confirm && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={confirm === "delete" ? `Xoá tài khoản ${u.email}?` : confirm === "all" ? "Xoá toàn bộ dữ liệu của người này?" : "Xoá lịch sử nghe của người này?"}
          description={
            confirm === "delete"
              ? "Xoá tài khoản cùng thư viện, playlist, lịch sử. File nhạc chỉ bị xoá nếu không còn ai khác có."
              : confirm === "all"
                ? "Thư viện, playlist, lượt thích, lịch sử và danh sách tải của người này bị xoá. Tài khoản vẫn còn."
                : "Thống kê và dữ liệu gợi ý của người này về trống. Nhạc và playlist giữ nguyên."
          }
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Huỷ
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
                      toast(`Đã xoá tài khoản, giải phóng ${r.filesFreed} file`, "success");
                      back();
                    }
                  } else {
                    await act(() => api(`/api/admin/users/${u.id}/reset`, { method: "POST", json: { scope: c } }), "Đã xoá");
                  }
                }}
              >
                Xoá
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
      <h4 className="mb-2 text-label text-fg-muted">Giờ hay nghe</h4>
      <div className="flex h-20 items-end gap-0.5" role="img" aria-label={`Lượt nghe theo giờ, nhiều nhất lúc ${hours.indexOf(Math.max(...hours))} giờ`}>
        {hours.map((n, h) => (
          <div key={h} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${h} giờ: ${n} lượt`}>
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
        <KV k="Phiên bản" v={d.ytdlp.version || (d.ytdlp.ready ? "?" : "chưa sẵn sàng")} />
        <KV k="Quản lý" v={d.ytdlp.managed ? "Vang tự cập nhật hằng ngày" : "bản cài sẵn / YTDLP_PATH"} />
        <KV k="JS runtime" v={d.ytdlp.jsRuntime || "không có"} />
        <KV k="ffmpeg" v={d.ffmpeg} mono />
        {d.ytdlp.error && <p className="text-body-sm text-danger">{d.ytdlp.error}</p>}
        <Button
          icon="retry"
          loading={busy === "yt"}
          disabled={!d.ytdlp.managed}
          onClick={() => run("yt", () => act(() => api<{ version: string }>("/api/admin/system/ytdlp-update", { method: "POST" }), "Đã cập nhật yt-dlp"))}
        >
          Cập nhật ngay
        </Button>
      </Card>

      <Card title="Lưu trữ" icon="library">
        <KV k="Nhạc" v={`${fmtBytes(d.storage.musicBytes)} · ${d.storage.musicFiles} file`} />
        <KV k="Ảnh bìa" v={fmtBytes(d.storage.coverBytes)} />
        <KV k="Cơ sở dữ liệu" v={fmtBytes(d.storage.dbBytes)} />
        <KV k="Bài trên máy chủ" v={`${d.storage.tracks} (dùng chung giữa các tài khoản)`} />
        <KV k="Bài không ai có" v={String(d.storage.orphanTracks)} />
        <KV k="Thư mục dữ liệu" v={d.dataDir} mono />
        <Button
          icon="trash"
          loading={busy === "clean"}
          onClick={() =>
            run("clean", async () => {
              const r = await act(() => api<{ orphanTracks: number; strayFiles: number; strayBytes: number; oldJobs: number }>("/api/admin/system/cleanup", { method: "POST" }));
              if (r) toast(`Đã dọn ${r.orphanTracks} bài không ai có, ${r.strayFiles} file thừa (${fmtBytes(r.strayBytes)}), ${r.oldJobs} job cũ`, "success");
            })
          }
        >
          Dọn dẹp
        </Button>
      </Card>

      <Card title="Phân tích nền" icon="stats">
        <KV k="Đo âm lượng còn chờ" v={String(d.analysis.loudnessPending)} />
        <KV k="Đặc trưng âm thanh" v={`${d.analysis.featuresReady} xong · còn ${d.analysis.featuresPending}`} />
        <KV k="Nguồn nghệ sĩ tương tự" v={d.recs.provider === "lastfm" ? "Last.fm" : "Deezer"} />
        <KV k="Tự động tải lần tới" v={d.autoNext ? new Date(d.autoNext).toLocaleString("vi-VN") : "—"} />
        <Button
          icon="retry"
          loading={busy === "cache"}
          onClick={() =>
            run("cache", async () => {
              const r = await act(() => api<{ removed: number }>("/api/admin/system/clear-cache", { method: "POST" }));
              if (r) toast(`Đã xoá ${r.removed} mục cache Deezer / Last.fm`, "success");
            })
          }
        >
          Xoá cache gợi ý
        </Button>
      </Card>

      <Card title="Email" icon="mail" status={d.mail.configured ? "ok" : "warn"}>
        <KV k="Trạng thái" v={d.mail.configured ? "Đã cấu hình" : "Chưa cấu hình (OTP, quên mật khẩu tắt)"} />
        <KV k="Máy chủ SMTP" v={d.mail.host} />
        <KV k="Gửi từ" v={d.mail.from || "—"} />
        <KV k="Địa chỉ công khai" v={d.publicUrl || "chưa đặt PUBLIC_URL"} />
        <p className="text-caption text-fg-muted">Cấu hình trong file .env (SMTP_USERNAME, SMTP_PASSWORD) rồi khởi động lại máy chủ.</p>
        <Button
          icon="mail"
          loading={busy === "mail"}
          disabled={!d.mail.configured}
          onClick={() =>
            run("mail", async () => {
              const r = await act(() => api<{ to: string }>("/api/admin/system/test-mail", { method: "POST" }));
              if (r) toast(`Đã gửi email thử tới ${r.to}`, "success");
            })
          }
        >
          Gửi email thử
        </Button>
      </Card>

      <Card title="Định dạng tải về" icon="music-note">
        <p className="text-body-sm text-fg-muted">Áp dụng cho mọi bài tải mới (file dùng chung). m4a (AAC) chạy mọi nơi kể cả iPhone; Opus nhỏ hơn ở cùng chất lượng.</p>
        {srv.data && (
          <div className="grid grid-cols-2 gap-3">
            <select
              className="input h-11"
              value={srv.data.audioFormat}
              aria-label="Định dạng"
              onChange={(e) => act(() => api("/api/admin/settings", { method: "PUT", json: { ...srv.data, audioFormat: e.target.value } }), "Đã lưu")}
            >
              <option value="m4a">m4a</option>
              <option value="opus">opus</option>
            </select>
            <select
              className="input h-11"
              value={srv.data.bitrate}
              aria-label="Chất lượng khi chuyển mã"
              onChange={(e) => act(() => api("/api/admin/settings", { method: "PUT", json: { ...srv.data, bitrate: +e.target.value } }), "Đã lưu")}
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

      <Card title="Người dùng" icon="users">
        <KV k="Tài khoản" v={`${d.users.total} (${d.users.admins} admin)`} />
        <KV k="Đang mở app" v={String(d.users.online)} />
        <KV k="Go" v={d.go} />
      </Card>

      <BrandingCard />
      <DiscordCard />
      <LogsPanel />

      <section className="rounded-card bg-surface-1 p-4 md:col-span-2">
        <h3 className="mb-2 flex items-center gap-2 text-title-3">
          <Icon name="download" size={20} className="text-accent" />
          Hàng chờ tải của mọi người
          <span className="text-body-sm font-normal text-fg-muted">
            · {active} đang chạy · {d.jobs.error ?? 0} lỗi
          </span>
        </h3>
        {jobs.data?.jobs.length ? (
          <ul className="flex flex-col">
            {jobs.data.jobs.map((j) => (
              <li key={j.id} className="flex items-center gap-3 border-t border-line py-2 first:border-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm">{j.title || j.url}</span>
                  <span className={`block truncate text-caption ${j.status === "error" ? "text-danger" : "text-fg-muted"}`}>
                    {j.email} · {j.status === "error" ? j.error : j.stage || j.status}
                    {j.status === "downloading" && j.progress > 0 ? ` ${Math.round(j.progress * 100)}%` : ""}
                  </span>
                </span>
                {j.status === "error" && (
                  <Button size="sm" icon="retry" aria-label="Thử lại" onClick={() => act(() => api(`/api/downloads/${j.id}/retry`, { method: "POST" }))} />
                )}
                <Button size="sm" variant="ghost" icon="close" aria-label="Huỷ / xoá job" onClick={() => act(() => api(`/api/downloads/${j.id}`, { method: "DELETE" }))} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-fg-muted">Không có job nào đang chạy hay lỗi.</p>
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
          <span className={`size-2.5 rounded-full ${status === "ok" ? "bg-success" : status === "warn" ? "bg-warning" : "bg-danger"}`} aria-label={status === "ok" ? "Ổn" : "Cần xem"} />
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
