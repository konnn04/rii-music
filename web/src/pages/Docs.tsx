import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { Icon } from "@/components/ui/Icon";
import { toast } from "@/components/ui/Toast";
import { t } from "@/i18n";

type Op = {
  tags: string[];
  summary: string;
  parameters?: { name: string; in: "path" | "query"; description?: string; required?: boolean }[];
  requestBody?: { content: { "application/json": { example: unknown } } };
  responses: Record<string, { description: string; content?: { "application/json": { example: unknown } } }>;
  security?: unknown[];
  "x-role"?: string;
};
type Spec = { info: { title: string; description: string }; servers: { url: string }[]; tags: { name: string }[]; paths: Record<string, Record<string, Op>> };

const methodColor: Record<string, string> = {
  get: "bg-[#2f6f4f] text-white",
  post: "bg-[#3d5fa8] text-white",
  put: "bg-[#8a6a1f] text-white",
  patch: "bg-[#7a4fa8] text-white",
  delete: "bg-[#a83d3d] text-white",
};

function copy(s: string) {
  navigator.clipboard.writeText(s).then(
    () => toast(t("common.copied")),
    () => toast(t("common.copyFailed"), "error"),
  );
}

/** /docs: the server's API, rendered from /api/openapi.json (public). */
export function DocsPage() {
  const brand = useBranding();
  const spec = useQuery({ queryKey: ["openapi"], queryFn: () => api<Spec>("/api/openapi.json") });
  const [filter, setFilter] = useState("");
  const base = spec.data?.servers[0]?.url ?? location.origin;

  const groups = useMemo(() => {
    if (!spec.data) return [];
    const f = filter.toLowerCase();
    return spec.data.tags.map((tag) => ({
      tag: tag.name,
      ops: Object.entries(spec.data!.paths)
        .flatMap(([path, ms]) => Object.entries(ms).map(([m, op]) => ({ path, method: m, op })))
        .filter((x) => x.op.tags[0] === tag.name && (!f || (x.path + " " + x.op.summary).toLowerCase().includes(f))),
    })).filter((g) => g.ops.length);
  }, [spec.data, filter]);

  const example = `import { RiiMusic } from "./riimusic-client";

const music = new RiiMusic("${base}", process.env.RIIMUSIC_TOKEN!);
const hits = await music.search("tìm em");
const { jobs } = await music.download(hits.results[0].url);
const job = await music.waitForJob(jobs[0].id);
console.log(job.status, job.trackId);`;

  return (
    <div className="min-h-dvh bg-canvas text-fg">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-canvas/90 px-4 py-3 backdrop-blur md:px-8">
        <a href="/" className="flex items-center gap-2">
          <img src={brand.logoUrl} alt="" className="size-7 rounded-xs object-contain" />
          <span className="text-title-3">{brand.name}</span>
        </a>
        <span className="rounded-xs bg-accent-soft px-2 text-label text-accent">API</span>
        <input className="input ml-auto h-10 w-48 md:w-72" placeholder={t("docs.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("docs.filter")} />
      </header>
      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6 md:px-8">
        <nav className="sticky top-20 hidden h-fit w-48 shrink-0 flex-col gap-1 lg:flex" aria-label={t("docs.sections")}>
          {groups.map((g) => (
            <a key={g.tag} href={`#${encodeURIComponent(g.tag)}`} className="rounded-control px-3 py-1.5 text-body-sm text-fg-muted hover:bg-surface-1 hover:text-fg">
              {g.tag}
            </a>
          ))}
        </nav>
        <main className="min-w-0 flex-1">
          <h1 className="text-title-1">{spec.data?.info.title ?? "API"}</h1>
          <p className="mt-2 max-w-3xl text-body text-fg-muted">{t("docs.intro")}</p>
          <ol className="mt-4 flex max-w-3xl list-decimal flex-col gap-1 pl-5 text-body-sm">
            <li>{t("docs.step1")}</li>
            <li>
              {t("docs.step2")} <code className="rounded-xs bg-surface-2 px-1.5 font-mono">Authorization: Bearer rii_…</code>
            </li>
            <li>
              {t("docs.step3")}{" "}
              <a className="text-accent hover:underline" href="/api/docs/client.ts" download>
                riimusic-client.ts
              </a>{" "}
              · <a className="text-accent hover:underline" href="/api/openapi.json">openapi.json</a>
            </li>
          </ol>
          <Code text={example} />

          {spec.isLoading && <Icon name="loader" size={28} />}
          {groups.map((g) => (
            <section key={g.tag} id={g.tag} className="mt-10 scroll-mt-20">
              <h2 className="mb-3 text-title-2">{g.tag}</h2>
              <div className="flex flex-col gap-3">
                {g.ops.map(({ path, method, op }) => (
                  <Endpoint key={method + path} base={base} path={path} method={method} op={op} />
                ))}
              </div>
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}

function Endpoint({ base, path, method, op }: { base: string; path: string; method: string; op: Op }) {
  const [open, setOpen] = useState(false);
  const body = op.requestBody?.content["application/json"].example;
  const resp = op.responses["200"]?.content?.["application/json"].example;
  const isPublic = Array.isArray(op.security) && op.security.length === 0;
  const isAgent = JSON.stringify(op.security ?? "").includes("agentToken");
  const query = (op.parameters ?? []).filter((p) => p.in === "query");
  const curl =
    `curl -X ${method.toUpperCase()} "${base}${path}${query.length ? "?" + query.map((q) => `${q.name}=…`).join("&") : ""}"` +
    (isPublic ? "" : ` \\\n  -H "Authorization: Bearer $RIIMUSIC_TOKEN"`) +
    (body !== undefined ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'` : "");
  return (
    <div className="rounded-card bg-surface-1">
      <button className="focus-ring flex w-full items-center gap-3 rounded-card px-4 py-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`w-16 shrink-0 rounded-xs py-0.5 text-center font-mono text-caption font-semibold uppercase ${methodColor[method] ?? "bg-surface-3"}`}>{method}</span>
        <code className="min-w-0 truncate font-mono text-body-sm">{path}</code>
        <span className="hidden min-w-0 flex-1 truncate text-body-sm text-fg-muted md:block">{op.summary}</span>
        {isPublic && <Tag>{t("docs.public")}</Tag>}
        {op["x-role"] === "admin" && <Tag>Admin</Tag>}
        {isAgent && <Tag>Agent</Tag>}
        <Icon name="chevron-down" size={18} className={`shrink-0 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-4 py-3">
          <p className="text-body-sm md:hidden">{op.summary}</p>
          {!!op.parameters?.length && (
            <table className="text-body-sm">
              <tbody>
                {op.parameters.map((p) => (
                  <tr key={p.in + p.name}>
                    <td className="py-0.5 pr-3 font-mono">{p.name}</td>
                    <td className="py-0.5 pr-3 text-caption text-fg-muted">{p.in}</td>
                    <td className="py-0.5 text-fg-muted">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {body !== undefined && <Code label={t("docs.body")} text={JSON.stringify(body, null, 2)} />}
          {resp !== undefined && <Code label={t("docs.response")} text={JSON.stringify(resp, null, 2)} />}
          <Code label="curl" text={curl} />
        </div>
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 rounded-xs bg-surface-3 px-1.5 text-caption text-fg-muted">{children}</span>;
}

function Code({ text, label }: { text: string; label?: string }) {
  return (
    <div className="relative mt-3">
      {label && <div className="mb-1 text-caption text-fg-muted">{label}</div>}
      <pre className="overflow-x-auto rounded-control bg-surface-2 p-3 pr-12 font-mono text-caption leading-relaxed">{text}</pre>
      <button className="focus-ring absolute right-2 top-[calc(theme(spacing.6)+4px)] rounded-xs p-1 text-fg-muted hover:text-fg" style={label ? undefined : { top: 8 }} onClick={() => copy(text)} aria-label={t("common.copy")}>
        <Icon name="clipboard" size={16} />
      </button>
    </div>
  );
}
