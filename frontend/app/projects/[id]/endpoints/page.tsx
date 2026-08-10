"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { Badge, Button, Card, Empty, Input, PageHeader, Pill, Progress, RefChip, StatusDot, Table } from "@/components/ui";

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.endpoints ?? [];
}

function M({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontFamily: "'JetBrains Mono',ui-monospace,monospace", fontSize: 12, ...style }}>
      {children}
    </span>
  );
}

const METHOD_COLORS: Record<string, string> = {
  GET: "var(--c-blue)",
  POST: "var(--c-green)",
  PUT: "var(--c-yellow)",
  PATCH: "var(--c-yellow)",
  DELETE: "var(--c-coral)",
};

function MethodBadge({ method }: { method: string }) {
  const m = (method || "").toUpperCase();
  const color = METHOD_COLORS[m] ?? "var(--text-secondary)";
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono',ui-monospace,monospace",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        color,
        border: `1px solid ${color}`,
        borderRadius: 6,
        padding: "2px 8px",
        display: "inline-block",
        minWidth: 52,
        textAlign: "center",
        background: "var(--bg)",
      }}
    >
      {m}
    </span>
  );
}

function Toggle({ on, onChange, disabled, testId }: { on: boolean; onChange: () => void; disabled?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      data-testid={testId}
      onClick={onChange}
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        border: "1px solid var(--border-strong)",
        background: on ? "var(--accent-fill)" : "var(--surface-3)",
        position: "relative",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "background 120ms",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          background: on ? "var(--accent-fg)" : "var(--text-muted)",
          transition: "left 120ms",
        }}
      />
    </button>
  );
}

export default function EndpointsPage() {
  const { id } = useParams<{ id: string }>();
  const canDo = useCan();

  const L = {
    title: "Endpoints",
    sub: "Import an OpenAPI / Swagger spec to discover testable endpoints",
    importCard: "Import spec",
    tabUrl: "Fetch from URL",
    tabFile: "Upload file",
    urlPh: "https://example.com/openapi.json",
    fetchBtn: "Import",
    filePick: "Pick a JSON / YAML file",
    importing: "Importing…",
    warnings: "Warnings",
    importResult: "Import result",
    inventory: "Endpoint inventory",
    method: "Method",
    path: "Path",
    summary: "Summary",
    params: "Params",
    tests: "Tests",
    coverage: "Coverage",
    lastOutcome: "Last outcome",
    security: "Security",
    secured: "Secured",
    open: "Open",
    included: "Included",
    empty: "No endpoints yet",
    emptyHint: "Import an OpenAPI spec to discover endpoints",
    loadError: "Failed to load data",
    retry: "Retry",
    added: "Added",
    updated: "Updated",
    removed: "Removed",
    total: "Total",
  };

  const [tab, setTab] = useState<"url" | "file">("url");
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [eps, setEps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);

  async function loadEps() {
    const r = await api(`/projects/${id}/endpoints`);
    setEps(asList(r));
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api(`/projects/${id}/endpoints`)
      .then((r) => alive && setEps(asList(r)))
      .catch((e) => alive && setError(e?.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  async function doImport(payload: { url?: string; file?: File }) {
    setImporting(true);
    setImportError(null);
    setResult(null);
    try {
      let res: any;
      if (payload.file) {
        const fd = new FormData();
        fd.append("file", payload.file);
        res = await api(`/projects/${id}/api-specs`, { form: fd });
      } else {
        res = await api(`/projects/${id}/api-specs`, { body: { url: payload.url } });
      }
      setResult(res ?? {});
      await loadEps();
    } catch (e: any) {
      setImportError(e?.message || String(e));
    } finally {
      setImporting(false);
    }
  }

  async function toggleRow(ep: any) {
    setBusyRow(ep.id);
    const next = !ep.excluded;
    try {
      await api(`/endpoints/${ep.id}`, { method: "PATCH", body: { excluded: next } });
      setEps((prev) => prev.map((x) => (x.id === ep.id ? { ...x, excluded: next } : x)));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyRow(null);
    }
  }

  const diffKeys: [string, string][] = [
    ["added", L.added],
    ["updated", L.updated],
    ["removed", L.removed],
    ["total", L.total],
  ];
  const diffEntries = result
    ? diffKeys.filter(([k]) => typeof result[k] === "number")
    : [];
  const warnings: any[] = Array.isArray(result?.warnings) ? result.warnings : [];

  return (
    <div data-testid="endpoints-page-root" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={L.title} sub={L.sub} actions={<RefChip id="FR-024" />} testId="endpoints-page-header" />

      {canDo("import_spec") && (
      <Card title={L.importCard} testId="endpoints-import-card">
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <Pill active={tab === "url"} onClick={() => setTab("url")} testId="endpoints-import-url-pill">
            {L.tabUrl}
          </Pill>
          <Pill active={tab === "file"} onClick={() => setTab("file")} testId="endpoints-import-file-pill">
            {L.tabFile}
          </Pill>
        </div>

        {tab === "url" ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Input
              placeholder={L.urlPh}
              value={url}
              onChange={(e: any) => setUrl(e.target.value)}
              testId="endpoints-import-url-input"
              style={{ flex: 1, minWidth: 260, fontFamily: "'JetBrains Mono',ui-monospace,monospace", fontSize: 12 }}
            />
            <Button disabled={importing || !url.trim()} onClick={() => doImport({ url: url.trim() })} testId="endpoints-import-submit-button">
              {importing ? L.importing : L.fetchBtn}
            </Button>
          </div>
        ) : (
          <div>
            <input
              ref={fileRef}
              data-testid="endpoints-import-file-input"
              type="file"
              accept=".json,.yaml,.yml"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doImport({ file: f });
                e.target.value = "";
              }}
            />
            <Button variant="secondary" disabled={importing} onClick={() => fileRef.current?.click()} testId="endpoints-import-file-button">
              {importing ? L.importing : L.filePick}
            </Button>
          </div>
        )}

        {importError && (
          <div style={{ marginTop: 12, fontSize: 13, color: "var(--error)" }}>{importError}</div>
        )}

        {result && (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {diffEntries.length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{L.importResult}:</span>
                {diffEntries.map(([k, label]) => (
                  <Badge key={k} tone={k === "removed" ? "error" : k === "updated" ? "warning" : k === "added" ? "success" : "muted"} testId={`endpoints-import-${k}-badge`}>
                    {label} <M style={{ fontSize: 11 }}>{result[k]}</M>
                  </Badge>
                ))}
              </div>
            )}
            {warnings.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--warning)",
                  background: "var(--warning-subtle, rgba(255,197,61,.16))",
                  borderRadius: 12,
                  padding: "10px 14px",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--warning)", marginBottom: 6 }}>
                  {L.warnings} ({warnings.length})
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                  {warnings.map((w, i) => (
                    <li key={i} style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      <M style={{ fontSize: 11 }}>{typeof w === "string" ? w : w?.message ?? JSON.stringify(w)}</M>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>
      )}

      <Card title={`${L.inventory}${eps.length ? ` (${eps.length})` : ""}`} pad={false} testId="endpoints-inventory-card">
        {loading ? (
          <div style={{ padding: 24, color: "var(--text-secondary)", fontSize: 13 }}>…</div>
        ) : error ? (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <div style={{ color: "var(--error)", fontSize: 13 }}>
              {L.loadError} — {error}
            </div>
            <Button
              variant="secondary"
              size="sm"
              testId="endpoints-inventory-retry-button"
              onClick={() => {
                setError(null);
                setLoading(true);
                loadEps()
                  .catch((e) => setError(e?.message || String(e)))
                  .finally(() => setLoading(false));
              }}
            >
              {L.retry}
            </Button>
          </div>
        ) : eps.length === 0 ? (
          <Empty title={L.empty} hint={L.emptyHint} testId="endpoints-empty-state" />
        ) : (
          <Table head={[L.method, L.path, L.summary, L.params, L.tests, L.coverage, L.lastOutcome, L.security, L.included]} testId="endpoints-table-root">
            {eps.map((ep) => {
              const params = Array.isArray(ep.parameters) ? ep.parameters.length : 0;
              const secured = Array.isArray(ep.security) ? ep.security.length > 0 : !!ep.security;
              const testCount = ep.test_count ?? 0;
              const covPct = ep.covered_params_pct ?? null;
              return (
                <tr
                  key={ep.id}
                  data-testid="endpoints-row"
                  style={{
                    opacity: ep.excluded ? 0.5 : 1,
                    background: !ep.excluded && testCount === 0 ? "rgba(255,197,61,.07)" : undefined,
                  }}
                >
                  <td>
                    <MethodBadge method={ep.method} />
                  </td>
                  <td>
                    <M style={{ color: "var(--text)" }}>{ep.path}</M>
                  </td>
                  <td style={{ fontSize: 13, color: "var(--text-secondary)" }}>{ep.summary ?? "—"}</td>
                  <td>
                    <M style={{ color: "var(--text-secondary)" }}>{params}</M>
                  </td>
                  <td>
                    <M style={{ color: testCount === 0 ? "var(--warning)" : "var(--text)" }}>{testCount}</M>
                  </td>
                  <td style={{ minWidth: 90 }}>
                    {covPct == null ? (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    ) : (
                      <div className="row" style={{ gap: 6, alignItems: "center" }}>
                        <div style={{ width: 52 }}>
                          <Progress pct={covPct} tone={covPct >= 80 ? "success" : covPct >= 40 ? "warning" : "error"} />
                        </div>
                        <M style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{covPct}%</M>
                      </div>
                    )}
                  </td>
                  <td>
                    {ep.last_outcome ? (
                      <span className="row" style={{ gap: 6, alignItems: "center" }}>
                        <StatusDot state={ep.last_outcome} testId="endpoints-row-outcome-dot" />
                        <M style={{ fontSize: 10.5 }}>{ep.last_outcome}</M>
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    )}
                  </td>
                  <td>
                    <Badge tone={secured ? "info" : "muted"}>{secured ? L.secured : L.open}</Badge>
                  </td>
                  <td>
                    {canDo("import_spec") && (
                      <Toggle on={!ep.excluded} disabled={busyRow === ep.id} onChange={() => toggleRow(ep)} testId="endpoints-row-include-toggle" />
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
