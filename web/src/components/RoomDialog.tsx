import { useState, type FormEvent } from "react";
import { closeRoom, createRoom, joinRoom, leaveRoom, resyncRoom, setMemberRole, useMyRole, useRoom } from "@/player/room";
import { usePlayer } from "@/player/store";
import { useMe } from "@/lib/queries";
import { t, tn } from "@/i18n";
import { Button, IconButton } from "./ui/Button";
import { Cover } from "./ui/Cover";
import { Dialog } from "./ui/Dialog";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";

function InitialAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const ch = (name.trim()[0] ?? "?").toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.45, background: `hsl(${h} 45% 42%)` }}
    >
      {ch}
    </span>
  );
}

/** Header/toolbar button that opens the Nghe chung dialog and shows live room status. */
export function RoomButton({ className = "" }: { className?: string }) {
  const room = useRoom((s) => s.room);
  const status = useRoom((s) => s.status);
  const [open, setOpen] = useState(false);

  const connected = room ? room.members.filter((m) => m.connected).length : 0;
  const badgeColor = status === "reconnecting" ? "bg-warning" : "bg-accent";

  return (
    <>
      <span className={`relative inline-flex shrink-0 ${className}`}>
        <IconButton
          icon="users"
          label={t("room.title")}
          size={22}
          active={!!room}
          onClick={() => setOpen(true)}
        />
        {room && (
          connected > 0 ? (
            <span
              aria-hidden
              className={`pointer-events-none absolute -right-0.5 top-0.5 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 text-fg-on-accent ${badgeColor}`}
            >
              {connected}
            </span>
          ) : (
            <span
              aria-hidden
              className={`pointer-events-none absolute right-2 top-2 size-2 rounded-full ${badgeColor}`}
            />
          )
        )}
      </span>
      <RoomDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Dialog to create, join, or manage a Nghe chung (listen together) room. */
export function RoomDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const room = useRoom((s) => s.room);
  const tracks = useRoom((s) => s.tracks);
  const status = useRoom((s) => s.status);
  const myRole = useMyRole();
  const meId = useMe().data?.user.id ?? "";
  const hasCurrent = usePlayer((s) => !!s.current);

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | "leave" | "close" | null>(null);
  const [roleBusyId, setRoleBusyId] = useState<string | null>(null);

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const nowTrack = room ? tracks.find((tr) => tr.id === room.state.queue[room.state.index]) : undefined;

  const onCreate = async () => {
    setBusy("create");
    try {
      await createRoom();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const onJoin = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy("join");
    try {
      await joinRoom(code);
      setCode("");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const onCopy = () => {
    if (!room) return;
    navigator.clipboard.writeText(room.code).then(
      () => toast(t("room.copied"), "success"),
      () => toast(t("common.copyFailed"), "error"),
    );
  };

  const onShare = () => {
    if (!room || !canShare) return;
    navigator.share({ text: t("room.shareText", { code: room.code }) }).catch(() => {});
  };

  const onRoleChange = async (userId: string, role: "controller" | "listener") => {
    setRoleBusyId(userId);
    try {
      await setMemberRole(userId, role);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRoleBusyId(null);
    }
  };

  const onCloseRoom = async () => {
    if (!window.confirm(t("room.closeConfirm"))) return;
    setBusy("close");
    try {
      await closeRoom();
      onOpenChange(false);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const onLeaveRoom = async () => {
    setBusy("leave");
    try {
      await leaveRoom();
      onOpenChange(false);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const footer = room ? (
    myRole === "host" ? (
      <Button variant="danger" loading={busy === "close"} disabled={!!busy} onClick={onCloseRoom}>
        {t("room.close")}
      </Button>
    ) : (
      <Button variant="secondary" loading={busy === "leave"} disabled={!!busy} onClick={onLeaveRoom}>
        {t("room.leave")}
      </Button>
    )
  ) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("room.title")} footer={footer}>
      {!room ? (
        <div className="flex flex-col">
          <p className="mb-4 text-body-sm text-fg-muted">{t("room.intro")}</p>

          <Button
            variant="primary"
            className="w-full"
            loading={busy === "create"}
            disabled={!hasCurrent || !!busy}
            onClick={onCreate}
          >
            {t("room.create")}
          </Button>
          {!hasCurrent && <p className="mt-1.5 text-center text-caption text-fg-muted">{t("room.needSong")}</p>}

          <div className="my-4 flex items-center gap-3 text-caption text-fg-subtle">
            <span className="h-px flex-1 bg-line" />
            <span>{t("room.or")}</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <form onSubmit={onJoin} className="flex flex-col gap-3">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
              maxLength={6}
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t("room.codePlaceholder")}
              aria-label={t("room.codePlaceholder")}
              className="input h-12 w-full text-center font-mono text-title-3 tracking-[0.25em] uppercase"
            />
            <Button type="submit" variant="secondary" className="w-full" loading={busy === "join"} disabled={code.length !== 6 || !!busy}>
              {t("room.join")}
            </Button>
          </form>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-control bg-surface-2 p-4 text-center">
            <div className="select-all font-mono text-title-1 tracking-[0.25em] text-fg">{room.code}</div>
            <div className="mt-3 flex items-center justify-center gap-2">
              <Button size="sm" icon="clipboard" onClick={onCopy}>
                {t("room.copy")}
              </Button>
              {canShare && (
                <Button size="sm" icon="share" onClick={onShare}>
                  {t("room.share")}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-body-sm">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${status === "reconnecting" ? "bg-warning" : "bg-success"}`}
              />
              <span className={status === "reconnecting" ? "text-warning" : "text-fg-muted"}>
                {status === "reconnecting" ? t("room.statusReconnecting") : t("room.statusConnected")}
              </span>
              {myRole && <span className="text-fg-muted">· {t(`room.role.${myRole}`)}</span>}
            </div>
            <Button variant="ghost" size="sm" icon="retry" onClick={() => resyncRoom()}>
              {t("room.resync")}
            </Button>
          </div>

          {nowTrack && (
            <div className="flex items-center gap-3 rounded-control bg-surface-2 p-2.5">
              <Cover trackId={nowTrack.id} hasCover={nowTrack.hasCover} size={40} />
              <div className="min-w-0 flex-1">
                <div className="text-caption text-fg-subtle">{t("room.nowPlaying")}</div>
                <div className="truncate text-label text-fg">{nowTrack.title}</div>
                <div className="truncate text-caption text-fg-muted">{nowTrack.artist}</div>
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 text-overline uppercase text-fg-subtle">
              {tn("room.members", room.members.length)}
            </div>
            <div className="flex flex-col gap-1">
              {room.members.map((m) => {
                const isMe = m.userId === meId;
                const canToggleRole = myRole === "host" && !isMe && m.role !== "host";
                return (
                  <div key={m.userId} className="flex items-center gap-2.5 rounded-control px-2 py-1.5">
                    <InitialAvatar name={m.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-label text-fg">
                          {m.name}
                          {isMe && <span className="ml-1 font-normal text-fg-muted">{t("room.you")}</span>}
                        </span>
                        <span
                          aria-hidden
                          className={`size-2 shrink-0 rounded-full ${m.connected ? "bg-success" : "bg-fg-subtle"}`}
                        />
                      </div>
                      {!m.connected && <div className="text-caption text-fg-muted">{t("room.disconnected")}</div>}
                    </div>
                    {canToggleRole ? (
                      <div className="inline-flex shrink-0 rounded-control bg-surface-1 p-0.5 text-caption">
                        {(["listener", "controller"] as const).map((r) => {
                          const active = m.role === r;
                          return (
                            <button
                              key={r}
                              type="button"
                              disabled={roleBusyId === m.userId}
                              aria-pressed={active}
                              onClick={() => {
                                if (!active) void onRoleChange(m.userId, r);
                              }}
                              className={`focus-ring rounded-xs px-2 py-1 transition-colors disabled:opacity-50 ${
                                active ? "bg-accent text-fg-on-accent" : "text-fg-muted hover:text-fg"
                              }`}
                            >
                              {t(`room.role.${r}`)}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="shrink-0 text-caption text-fg-muted">{t(`room.role.${m.role}`)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Slim status strip shown while in a Nghe chung room. */
export function RoomStrip({ className = "" }: { className?: string }) {
  const room = useRoom((s) => s.room);
  const status = useRoom((s) => s.status);
  const myRole = useMyRole();
  const [open, setOpen] = useState(false);

  if (!room) return null;

  return (
    <>
      <div
        role="status"
        className={`flex items-center gap-2 rounded-control bg-accent-soft px-3 py-2 text-body-sm ${className}`}
      >
        <Icon name="users" size={18} className={`shrink-0 ${status === "reconnecting" ? "text-warning" : "text-accent"}`} />
        <div className="min-w-0 flex-1 truncate">
          <span className="font-medium text-fg">{t("room.inRoom", { code: room.code })}</span>
          {myRole && <span className="text-fg-muted"> · {t(`room.role.${myRole}`)}</span>}
          {status === "reconnecting" && <span className="text-warning"> · {t("room.statusReconnecting")}</span>}
        </div>
        <Button variant="ghost" size="sm" className="!h-8 shrink-0 px-2.5 text-accent" onClick={() => setOpen(true)}>
          {t("room.open")}
        </Button>
      </div>
      <RoomDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
