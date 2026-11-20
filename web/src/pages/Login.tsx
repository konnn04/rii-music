import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { t } from "@/i18n";
import { useBranding } from "@/lib/branding";

type Mode = "password" | "otp" | "forgot";

/** Sign in: email + password, email + one-time code, or reset a forgotten password. */
export function Login({ onDone }: { onDone: () => void }) {
  const brand = useBranding();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState(() => localStorage.getItem("vang-last-email") ?? "");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false); // a code was emailed (otp / forgot)
  const [cooldown, setCooldown] = useState(0);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setSent(false);
    setCode("");
    setPw("");
    setPw2("");
    setErr("");
    setInfo("");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      await api("/api/auth/otp", { method: "POST", json: { email, purpose: mode === "forgot" ? "reset" : "login" } });
      setSent(true);
      setCooldown(60);
      setInfo(t("auth.codeSent", { email }));
    });

  const signedIn = () => {
    localStorage.setItem("vang-last-email", email.trim().toLowerCase());
    onDone();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "password") {
      run(async () => {
        await api("/api/auth/login", { method: "POST", json: { email, password: pw } });
        signedIn();
      });
    } else if (!sent) {
      sendCode();
    } else if (mode === "otp") {
      run(async () => {
        await api("/api/auth/otp/verify", { method: "POST", json: { email, code } });
        signedIn();
      });
    } else {
      if (pw !== pw2) {
        setErr(t("auth.passwordMismatch"));
        return;
      }
      run(async () => {
        await api("/api/auth/reset", { method: "POST", json: { email, code, password: pw, confirm: pw2 } });
        signedIn();
      });
    }
  };

  const title = mode === "password" ? t("auth.title.password") : mode === "otp" ? t("auth.title.otp") : t("auth.title.forgot");
  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());
  const canSubmit =
    mode === "password" ? emailOk && !!pw : !sent ? emailOk : mode === "otp" ? code.length === 6 : code.length === 6 && pw.length >= 8 && !!pw2;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-6 pt-safe pb-safe">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5 md:rounded-sheet md:bg-surface-1 md:p-8 md:shadow-float" noValidate>
        <div className="flex flex-col items-center gap-3 text-center">
          <img src={brand.logoUrl} alt="" className="size-16 rounded-card" />
          <h1 className="text-title-1">{brand.name}</h1>
          <p className="text-body-sm text-fg-muted">{title}</p>
        </div>

        <Field label={t("auth.field.email")}>
          <input
            type="email"
            autoComplete="username"
            autoFocus={!email}
            value={email}
            disabled={sent}
            onChange={(e) => setEmail(e.target.value)}
            className="input h-12"
            inputMode="email"
          />
        </Field>

        {mode === "password" && (
          <Field label={t("auth.field.password")}>
            <input type="password" autoComplete="current-password" autoFocus={!!email} value={pw} onChange={(e) => setPw(e.target.value)} className="input h-12" />
          </Field>
        )}

        {mode !== "password" && sent && (
          <Field label={t("auth.field.code")}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              className="input h-12 text-center font-mono text-title-3 tracking-[0.4em]"
              aria-describedby="login-info"
            />
          </Field>
        )}

        {mode === "forgot" && sent && (
          <>
            <Field label={t("auth.field.newPassword")}>
              <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className="input h-12" />
            </Field>
            <Field label={t("auth.field.confirmPassword")}>
              <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="input h-12" />
            </Field>
          </>
        )}

        {info && !err && (
          <p id="login-info" className="-mt-2 text-body-sm text-fg-muted" aria-live="polite">
            {info}
          </p>
        )}
        {err && (
          <p role="alert" className="-mt-2 text-body-sm text-danger">
            {err}
          </p>
        )}

        <Button variant="primary" type="submit" loading={busy} disabled={!canSubmit} className="h-12">
          {mode === "password" ? t("auth.submit.signIn") : !sent ? t("auth.submit.sendCode") : mode === "otp" ? t("auth.submit.signIn") : t("auth.submit.resetPassword")}
        </Button>

        {mode !== "password" && sent && (
          <button type="button" className="focus-ring -mt-2 h-10 rounded-control text-label text-fg-muted enabled:hover:text-fg disabled:opacity-60" disabled={cooldown > 0 || busy} onClick={sendCode}>
            {cooldown > 0 ? t("auth.resendCooldown", { seconds: cooldown }) : t("auth.resend")}
          </button>
        )}

        <div className="flex flex-col items-center gap-1 text-label">
          {mode !== "otp" && (
            <button type="button" className="focus-ring h-10 rounded-control px-3 text-accent hover:underline" onClick={() => switchMode("otp")}>
              {t("auth.switch.otp")}
            </button>
          )}
          {mode !== "forgot" && (
            <button type="button" className="focus-ring h-10 rounded-control px-3 text-fg-muted hover:text-fg" onClick={() => switchMode("forgot")}>
              {t("auth.switch.forgot")}
            </button>
          )}
          {mode !== "password" && (
            <button type="button" className="focus-ring h-10 rounded-control px-3 text-fg-muted hover:text-fg" onClick={() => switchMode("password")}>
              {t("auth.switch.password")}
            </button>
          )}
        </div>

        <p className="text-center text-caption text-fg-subtle">
          {t("auth.footerNote")}
        </p>
      </form>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label text-fg-muted">{label}</span>
      {children}
    </label>
  );
}
