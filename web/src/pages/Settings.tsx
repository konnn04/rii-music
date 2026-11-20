import { useState } from "react";
import { ApiTokens, DiscordPresence, LanguageSettings } from "./SettingsExtra";
import { Link } from "@tanstack/react-router";
import { api, type AutoDLStatus, type Me, type Settings } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { fmtAgo, fmtBytes } from "@/lib/format";
import { queryClient, useMe, useSaveSettings, useSettings } from "@/lib/queries";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { engine, isIOS } from "@/player/engine";
import { Slider } from "@/components/ui/Slider";
import { Spinner } from "@/components/ui/misc";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Avatar, PageHeader, LogoutButton } from "@/components/layout/AppShell";

export function SettingsPage() {
  const { data } = useSettings();
  const save = useSaveSettings();
  const [cf, setCf] = useState<number | null>(null);
  const isAdmin = useMe().data?.user.role === "admin";
  if (!data) return <Spinner />;
  const set = (p: Partial<Settings>) => save.mutate(p);

  return (
    <div>
      <PageHeader
        title="Cài đặt"
        actions={
          <div className="flex items-center gap-1 lg:hidden">
            {isAdmin && (
              <Link to="/admin" className="focus-ring state-layer flex h-10 items-center gap-1.5 rounded-full bg-surface-1 px-3 text-label">
                <Icon name="shield" size={18} className="text-accent" /> Quản trị
              </Link>
            )}
            <LogoutButton />
          </div>
        }
      />
      <div className="flex max-w-2xl flex-col gap-6 px-4 md:px-6">
        <AccountSettings />
        <LanguageSettings />

        <Group title="Phát nhạc" icon="play">
          <Row label="Chuyển tiếp (crossfade)" hint={data.crossfadeSec === 0 ? "Tắt — chuyển bài ngay" : `Hai bài chồng nhau ${cf ?? data.crossfadeSec} giây`}>
            <div className="flex w-full items-center gap-3 md:w-56">
              <Slider
                label="Thời lượng crossfade"
                value={cf ?? data.crossfadeSec}
                max={12}
                step={1}
                onChange={setCf}
                onCommit={(v) => {
                  set({ crossfadeSec: v });
                  setCf(null);
                }}
                className="flex-1"
                valueText={`${cf ?? data.crossfadeSec} giây`}
              />
              <span className="w-8 text-right text-label tabular">{cf ?? data.crossfadeSec}s</span>
            </div>
          </Row>
          <Toggle label="Liền mạch trong album (gapless)" hint="Không crossfade khi hai bài liền nhau cùng album — hợp với album live, album liền mạch." on={data.gaplessAlbum} set={(v) => set({ gaplessAlbum: v })} />
          <Toggle label="Chuẩn hoá âm lượng" hint="Đưa mọi bài về cùng độ to (−14 LUFS, đo ngầm ngay sau khi tải về)." on={data.normalize} set={(v) => set({ normalize: v })} />
          <Toggle
            label="Chế độ âm thanh đơn giản"
            hint={`Không dùng Web Audio. Bật nếu nhạc tắt khi khoá màn hình (hay gặp trên iPhone). ${isIOS ? "Trên iPhone, chế độ này không có crossfade. " : ""}Áp dụng cho thiết bị này, trang sẽ tải lại.`}
            on={engine.simpleMode}
            set={(v) => engine.setSimpleMode(v)}
          />
        </Group>

        <AutoDownloadSettings data={data} set={set} />

        <Group title="Giao diện" icon="sun">
          <Row label="Chủ đề">
            <Segmented
              value={data.theme}
              options={[
                ["dark", "Tối"],
                ["light", "Sáng"],
                ["system", "Theo máy"],
              ]}
              onChange={(v) => set({ theme: v as Settings["theme"] })}
            />
          </Row>
        </Group>

        <DiscordPresence />
        <ApiTokens />
        <DataSettings />

        <Group title="Phím tắt (PC)" icon="keyboard">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 py-2 text-body-sm">
            {[
              ["Space", "Phát / tạm dừng"],
              ["← / →", "Tua 5 giây"],
              ["Shift + ← / →", "Bài trước / bài sau"],
              ["M", "Tắt / bật tiếng"],
              ["L", "Lời bài hát toàn màn hình"],
              ["Q", "Hàng đợi"],
              ["/", "Tìm kiếm"],
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

      </div>
    </div>
  );
}

function AutoDownloadSettings({ data, set }: { data: Settings; set: (p: Partial<Settings>) => void }) {
  const st = useQuery({ queryKey: ["autodl"], queryFn: () => api<AutoDLStatus>("/api/autodl"), refetchInterval: 60_000 });
  const [running, setRunning] = useState(false);
  const s = st.data;
  const pct = s ? Math.min(100, (s.usedBytes / s.limitBytes) * 100) : 0;
  return (
    <Group title="Tự động tải nhạc" icon="radio">
      <Toggle
        label="Tự động tải nhạc"
        hint="Cứ 6 giờ xem lại thói quen nghe và tải trước bài của nghệ sĩ bạn hay nghe và nghệ sĩ tương tự, tối đa 8 bài mỗi lần."
        on={data.autoDownload}
        set={(v) => set({ autoDownload: v })}
      />
      <p className="py-3 text-body-sm text-fg-muted">
        Khi thư viện vượt giới hạn dung lượng (admin đặt cho tài khoản của bạn), Vang tự bỏ bài ít khả năng nghe nhất. Không bao giờ bỏ bài đã thích, bài trong
        playlist, bài thêm trong 3 ngày qua hoặc nghe trong 14 ngày qua.
      </p>
      {s && (
        <div className="flex flex-col gap-3 py-4">
          <div className="flex items-baseline justify-between text-body-sm">
            <span>
              Đang dùng {fmtBytes(s.usedBytes)} / {fmtBytes(s.limitBytes)}
            </span>
            <span className="text-fg-muted">
              {s.tracks} bài · {s.autoTracks} bài tự tải
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label="Dung lượng nhạc đã dùng" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full rounded-full ${pct >= 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
          </div>
          {data.autoDownload && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 text-body-sm text-fg-muted">
                {s.running
                  ? "Đang xem lại thói quen nghe…"
                  : s.lastRun
                    ? `Lần chạy gần nhất ${fmtAgo(s.lastRun)}: ${s.lastMessage}${s.lastEvicted ? `, đã xoá ${s.lastEvicted} bài ít nghe` : ""}.`
                    : "Chưa chạy lần nào."}
                {s.pending > 0 && ` Đang tải ${s.pending} bài.`}
              </div>
              <Button
                size="sm"
                icon="retry"
                loading={running || s.running}
                onClick={async () => {
                  setRunning(true);
                  try {
                    await api("/api/autodl/run", { method: "POST" });
                    toast("Đang xem lại thói quen nghe và chọn bài để tải", "success");
                  } finally {
                    setRunning(false);
                  }
                }}
              >
                Chạy ngay
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
    toast("Đã lưu tên", "success");
  };
  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (pw.next !== pw.confirm) {
      setErr("Hai lần nhập mật khẩu mới không khớp");
      return;
    }
    setBusy(true);
    try {
      const d = await api<Me>("/api/me/password", { method: "POST", json: { current: pw.current, password: pw.next, confirm: pw.confirm } });
      queryClient.setQueryData(["me"], d);
      setPw({ current: "", next: "", confirm: "" });
      toast(u.hasPassword ? "Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất." : "Đã đặt mật khẩu", "success");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title="Tài khoản" icon="users">
      <div className="flex items-center gap-3 py-4">
        <Avatar name={u.name || u.email} size={48} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body">{u.name || "Chưa đặt tên"}</div>
          <div className="truncate text-body-sm text-fg-muted">
            {u.email} · {u.role === "admin" ? "Admin" : "Người nghe"}
          </div>
        </div>
      </div>
      <Row label="Tên hiển thị">
        <div className="flex w-full gap-2 md:w-72">
          <input className="input h-11 min-w-0 flex-1" value={name ?? u.name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Tên của bạn" />
          <Button disabled={name === null || name.trim() === u.name} onClick={saveName}>
            Lưu
          </Button>
        </div>
      </Row>
      <div className="flex flex-col gap-2 py-4">
        <div className="flex items-baseline justify-between text-body-sm">
          <span>Dung lượng nhạc</span>
          <span className="text-fg-muted">
            {fmtBytes(me.data.usedBytes)} / {fmtBytes(me.data.limitBytes)} · {me.data.tracks} bài
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label="Dung lượng nhạc đã dùng" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${pct >= 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-caption text-fg-muted">Giới hạn do admin đặt. Bài có sẵn trên máy chủ cũng tính vào thư viện của bạn.</p>
      </div>
      <form onSubmit={changePw} className="flex flex-col gap-3 py-4">
        <div className="text-body">{u.hasPassword ? "Đổi mật khẩu" : "Đặt mật khẩu"}</div>
        {!u.hasPassword && <p className="-mt-2 text-body-sm text-fg-muted">Bạn đang đăng nhập bằng mã qua email. Đặt mật khẩu để đăng nhập nhanh hơn.</p>}
        <input type="text" autoComplete="username" value={u.email} readOnly hidden />
        {u.hasPassword && (
          <input className="input h-11" type="password" autoComplete="current-password" placeholder="Mật khẩu hiện tại" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        )}
        <input className="input h-11" type="password" autoComplete="new-password" placeholder="Mật khẩu mới (ít nhất 8 ký tự)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        <input className="input h-11" type="password" autoComplete="new-password" placeholder="Nhập lại mật khẩu mới" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        {err && (
          <p role="alert" className="text-body-sm text-danger">
            {err}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-caption text-fg-muted">Quên mật khẩu? Đăng xuất rồi chọn “Quên mật khẩu?” để nhận mã qua email.</span>
          <Button type="submit" variant="primary" loading={busy} disabled={(u.hasPassword && !pw.current) || pw.next.length < 8 || !pw.confirm}>
            {u.hasPassword ? "Đổi mật khẩu" : "Đặt mật khẩu"}
          </Button>
        </div>
      </form>
      <p className="py-3 text-caption text-fg-subtle">Admin của máy chủ xem được thói quen nghe nhạc của bạn (bài hay nghe, thời gian nghe) để quản lý và gợi ý.</p>
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
  const phrase = scope === "all" ? "XOÁ HẾT" : "XOÁ LỊCH SỬ";
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
        localStorage.removeItem("vang-player");
        localStorage.removeItem("vang-pos");
        location.replace("/");
        return;
      }
      queryClient.invalidateQueries();
      toast("Đã xoá lịch sử nghe", "success");
      close();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title="Dữ liệu" icon="trash">
      <Row label="Xoá lịch sử nghe" hint="Xoá lượt nghe, thống kê và phản hồi “ít gợi ý”. Giữ nguyên nhạc, playlist, lời bài hát.">
        <Button variant="danger" onClick={() => setScope("history")}>
          Xoá lịch sử
        </Button>
      </Row>
      <Row
        label="Xoá toàn bộ dữ liệu của tôi"
        hint="Xoá thư viện, playlist, lượt thích, lịch sử và danh sách tải của tài khoản này. Giữ tài khoản và cài đặt. Người khác không bị ảnh hưởng."
      >
        <Button variant="danger" icon="trash" onClick={() => setScope("all")}>
          Xoá toàn bộ
        </Button>
      </Row>
      {scope && (
        <Dialog
          open
          onOpenChange={(o) => !o && close()}
          title={scope === "all" ? "Xoá toàn bộ dữ liệu của bạn?" : "Xoá lịch sử nghe?"}
          description={
            scope === "all"
              ? "Thư viện, playlist, lượt thích và lịch sử của bạn sẽ bị xoá, không hoàn tác được. Các lượt tải dở cũng bị huỷ."
              : "Thống kê, Tiếp tục nghe và dữ liệu cho đề xuất sẽ trở về trống."
          }
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                Huỷ
              </Button>
              <Button variant="danger" icon="trash" loading={busy} disabled={typed.trim().toUpperCase() !== phrase} onClick={run}>
                Xoá
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-body-sm text-fg-muted">
              Gõ <strong className="text-fg">{phrase}</strong> để xác nhận
            </span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
          </label>
        </Dialog>
      )}
    </Group>
  );
}
