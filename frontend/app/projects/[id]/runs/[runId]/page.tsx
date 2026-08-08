"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useParams } from "next/navigation";
import { API, api, getToken } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { Badge, Button, Card, DateTimeText, Empty, PageHeader, Pill, RefChip, Select, SeverityBadge, StatCard, StatusDot, Table, fmtDateTime, stateTone } from "@/components/ui";

type Tone = "success" | "warning" | "error" | "info" | "muted" | "accent";

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.cases ?? x?.runs ?? [];
}

function M({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span dir="ltr" style={{ fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace", fontSize: 12, ...style }}>
      {children}
    </span>
  );
}

function JsonBlock({ value }: { value: any }) {
  return (
    <pre
      dir="ltr"
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "10px 12px",
        margin: 0,
        fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace",
        fontSize: 11.5,
        lineHeight: 1.6,
        color: "var(--text-secondary)",
        overflowX: "auto",
        whiteSpace: "pre",
        textAlign: "left",
        maxHeight: 260,
        overflowY: "auto",
      }}
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function shortId(id?: string): string {
  return id ? String(id).slice(0, 8) : "—";
}

function fmtDur(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

const OUTCOME_TONE: Record<string, Tone> = {
  passed: "success",
  failed: "error",
  errored: "warning",
  skipped: "muted",
};

export default function RunReportPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const { lang } = useLang();

  const L =
    lang === "ar"
      ? {
          title: "تقرير التشغيل",
          env: "البيئة",
          started: "البداية",
          finished: "النهاية",
          initiator: "المشغّل",
          exportHtml: "تصدير HTML",
          exportHint: "يُفتح التقرير في تبويب جديد (يتطلب جلسة موثّقة)",
          total: "الكل",
          passed: "ناجح",
          failed: "فاشل",
          errored: "خطأ",
          duration: "المدة",
          tabFailures: "الإخفاقات",
          tabAll: "جميع النتائج",
          tabCompare: "مقارنة",
          noFailures: "لا توجد إخفاقات",
          noFailuresHint: "جميع الحالات نجحت في هذا التشغيل",
          stepsRepro: "خطوات إعادة الإنتاج",
          request: "الطلب",
          response: "الاستجابة",
          expected: "المتوقع",
          actual: "الفعلي",
          evidence: "أدلة التحقّقات",
          reqs: "المتطلبات",
          caseCol: "الحالة",
          outcome: "النتيجة",
          durationCol: "المدة",
          empty: "لا توجد نتائج",
          emptyHint: "لم تكتمل أي حالة في هذا التشغيل بعد",
          compareWith: "قارن مع تشغيل آخر",
          pickRun: "اختر تشغيلًا…",
          newlyFailing: "أخفق حديثًا",
          newlyPassing: "نجح حديثًا",
          noDiff: "لا فروقات",
          loadError: "تعذّر تحميل التقرير",
          retry: "إعادة المحاولة",
          failReason: "سبب الإخفاق",
          sevAll: "الكل",
          sevCritical: "حرج",
          sevMajor: "كبير",
          sevMinor: "طفيف",
          perf: "الأداء",
          perfEndpoint: "الواجهة",
          perfCalls: "النداءات",
          coverageDelta: "فرق التغطية",
          unchanged: "دون تغيير",
          pts: "نقطة",
        }
      : {
          title: "Run report",
          env: "Environment",
          started: "Started",
          finished: "Finished",
          initiator: "Initiator",
          exportHtml: "Export HTML",
          exportHint: "Opens the report in a new tab (requires an authenticated session)",
          total: "Total",
          passed: "Passed",
          failed: "Failed",
          errored: "Errored",
          duration: "Duration",
          tabFailures: "Failures",
          tabAll: "All results",
          tabCompare: "Compare",
          noFailures: "No failures",
          noFailuresHint: "Every case passed in this run",
          stepsRepro: "Steps to reproduce",
          request: "Request",
          response: "Response",
          expected: "Expected",
          actual: "Actual",
          evidence: "Assertion evidence",
          reqs: "Requirements",
          caseCol: "Case",
          outcome: "Outcome",
          durationCol: "Duration",
          empty: "No results",
          emptyHint: "No case has finished in this run yet",
          compareWith: "Compare with another run",
          pickRun: "Pick a run…",
          newlyFailing: "Newly failing",
          newlyPassing: "Newly passing",
          noDiff: "No differences",
          loadError: "Failed to load report",
          retry: "Retry",
          failReason: "Failure reason",
          sevAll: "All",
          sevCritical: "Critical",
          sevMajor: "Major",
          sevMinor: "Minor",
          perf: "Performance",
          perfEndpoint: "Endpoint",
          perfCalls: "Calls",
          coverageDelta: "Coverage delta",
          unchanged: "Unchanged",
          pts: "pts",
        };

  const outcomeLabel = (o: string) =>
    lang === "ar"
      ? ({ passed: "ناجح", failed: "فاشل", errored: "خطأ", skipped: "متجاوز" } as Record<string, string>)[o] ?? o
      : o;

  const [report, setReport] = useState<any | null>(null);
  const [results, setResults] = useState<any[]>([]);
  const [projRuns, setProjRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<"failures" | "all" | "compare">("failures");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sevF, setSevF] = useState("all");

  const [otherRun, setOtherRun] = useState("");
  const [compare, setCompare] = useState<any | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    return Promise.all([
      api(`/runs/${runId}/report`),
      api(`/runs/${runId}/results`).catch(() => null),
      api(`/projects/${id}/runs`).catch(() => null),
    ])
      .then(([rep, res, pr]) => {
        setReport(rep ?? {});
        setResults(res ? asList(res) : []);
        setProjRuns(pr ? asList(pr) : []);
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, runId]);

  useEffect(() => {
    if (!otherRun) {
      setCompare(null);
      return;
    }
    let alive = true;
    setCompareLoading(true);
    setCompareError(null);
    api(`/runs/${runId}/compare/${otherRun}`)
      .then((c) => alive && setCompare(c ?? {}))
      .catch((e) => alive && setCompareError(e?.message || String(e)))
      .finally(() => alive && setCompareLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherRun]);

  async function openHtmlReport() {
    try {
      const token = getToken();
      const res = await fetch(`${API}/runs/${runId}/report.html`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  const run = report?.run ?? {};
  const counts = report?.counts ?? run?.counts ?? {};
  const cases: any[] = Array.isArray(report?.cases) ? report.cases : [];

  const resultByCase = useMemo(() => {
    const m: Record<string, any> = {};
    results.forEach((r) => {
      const cid = r.test_case_id ?? r.test_case?.id;
      if (cid) m[cid] = r;
    });
    return m;
  }, [results]);

  const failures = cases.filter((c) => c.outcome === "failed" || c.outcome === "errored");
  const sevFailures = sevF === "all" ? failures : failures.filter((c) => c.severity === sevF);
  const perf: any[] = Array.isArray(report?.perf) ? report.perf : [];

  const durationMs = useMemo(() => {
    const s = run.started_at ? Date.parse(run.started_at) : NaN;
    const f = run.finished_at ? Date.parse(run.finished_at) : NaN;
    if (isFinite(s) && isFinite(f) && f >= s) return f - s;
    return cases.reduce((acc, c) => acc + (Number(c.duration_ms) || 0), 0);
  }, [run, cases]);

  const envName = run.environment?.name ?? run.environment_name ?? report?.environment?.name ?? "—";
  const initiator = run.initiator?.name ?? run.initiated_by_name ?? run.initiated_by ?? run.created_by ?? "—";

  function caseId(c: any): string {
    return c.test_case?.id ?? c.test_case_id ?? c.id ?? "";
  }
  function caseTitle(c: any): string {
    return c.test_case?.title ?? c.title ?? "—";
  }
  function caseReqChips(c: any): any[] {
    return c.requirements ?? c.test_case?.requirements ?? [];
  }

  function renderFailureReason(fr: any) {
    if (!fr) return null;
    if (typeof fr === "object") {
      return (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {fr.message && <span style={{ fontSize: 12, color: "var(--error)" }}>{fr.message}</span>}
          {fr.expected !== undefined && (
            <Badge tone="success">
              {L.expected}: <M style={{ fontSize: 11 }}>{typeof fr.expected === "object" ? JSON.stringify(fr.expected) : String(fr.expected)}</M>
            </Badge>
          )}
          {fr.actual !== undefined && (
            <Badge tone="error">
              {L.actual}: <M style={{ fontSize: 11 }}>{typeof fr.actual === "object" ? JSON.stringify(fr.actual) : String(fr.actual)}</M>
            </Badge>
          )}
        </div>
      );
    }
    return <span style={{ fontSize: 12, color: "var(--error)" }}>{String(fr)}</span>;
  }

  const compareRuns = projRuns.filter((r) => r.id !== runId);
  const newlyFailing: any[] = Array.isArray(compare?.newly_failing) ? compare.newly_failing : [];
  const newlyPassing: any[] = Array.isArray(compare?.newly_passing) ? compare.newly_passing : [];

  function compareItemLabel(x: any): string {
    if (typeof x === "string") return x;
    return x?.title ?? x?.test_case?.title ?? x?.test_case_id ?? x?.id ?? "—";
  }

  if (loading) {
    return <div style={{ padding: 24, color: "var(--text-secondary)", fontSize: 13 }}>…</div>;
  }

  if (error && !report) {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
        <div style={{ color: "var(--error)", fontSize: 13 }}>
          {L.loadError} — {error}
        </div>
        <Button variant="secondary" size="sm" onClick={() => load()}>
          {L.retry}
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="runs-report-page-root" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        testId="runs-report-page-header"
        title={
          <span style={{ display: "inline-flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {L.title}{" "}
            <M style={{ fontSize: 15, color: "var(--accent)" }}>
              {run.display_id ? `#${run.display_id}` : shortId(String(runId))}
            </M>
            {run.state && (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <StatusDot state={run.state} testId="runs-report-status-dot" />
                <Badge tone={stateTone(run.state)} testId="runs-report-state-badge" state={run.state}>{run.state}</Badge>
              </span>
            )}
          </span>
        }
        sub={
          <span style={{ display: "inline-flex", gap: 14, flexWrap: "wrap" }}>
            <span>
              {L.env}: {envName}
            </span>
            <span>
              {L.started}: <DateTimeText value={run.started_at} />
            </span>
            <span>
              {L.finished}: <DateTimeText value={run.finished_at} />
            </span>
            <span>
              {L.initiator}: {initiator}
            </span>
          </span>
        }
        actions={
          <Button variant="secondary" testId="runs-report-export-button" onClick={openHtmlReport} title={L.exportHint}>
            {L.exportHtml}
          </Button>
        }
      />

      {error && <div style={{ fontSize: 13, color: "var(--error)" }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
        <StatCard value={counts.total ?? cases.length} label={L.total} testId="runs-report-total-stat" />
        <StatCard value={counts.passed ?? 0} label={L.passed} color="var(--success)" testId="runs-report-passed-stat" />
        <StatCard value={counts.failed ?? 0} label={L.failed} color="var(--error)" testId="runs-report-failed-stat" />
        <StatCard value={counts.errored ?? 0} label={L.errored} color="var(--warning)" testId="runs-report-errored-stat" />
        <StatCard value={fmtDur(durationMs)} label={L.duration} testId="runs-report-duration-stat" />
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Pill active={tab === "failures"} testId="runs-report-tab-failures-pill" onClick={() => setTab("failures")}>
          {L.tabFailures} ({failures.length})
        </Pill>
        <Pill active={tab === "all"} testId="runs-report-tab-all-pill" onClick={() => setTab("all")}>
          {L.tabAll} ({cases.length})
        </Pill>
        <Pill active={tab === "compare"} testId="runs-report-tab-compare-pill" onClick={() => setTab("compare")}>
          {L.tabCompare}
        </Pill>
      </div>

      {/* Failures */}
      {tab === "failures" &&
        (failures.length === 0 ? (
          <Card>
            <Empty icon="✓" title={L.noFailures} hint={L.noFailuresHint} testId="runs-report-no-failures-empty" />
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[
                ["all", L.sevAll],
                ["critical", L.sevCritical],
                ["major", L.sevMajor],
                ["minor", L.sevMinor],
              ].map(([v, label]) => (
                <Pill key={v} active={sevF === v} testId={`runs-report-severity-${v}-pill`} onClick={() => setSevF(v)}>
                  {label}
                  {v !== "all" && (
                    <M style={{ fontSize: 10, marginInlineStart: 4 }}>
                      {failures.filter((c) => c.severity === v).length}
                    </M>
                  )}
                </Pill>
              ))}
            </div>
            {sevFailures.map((c, i) => {
              const cid = caseId(c);
              const isOpen = expanded.has(cid || String(i));
              const key = cid || String(i);
              const res = resultByCase[cid];
              const evidenceSteps: any[] = Array.isArray(res?.evidence) ? res.evidence : Array.isArray(res?.steps) ? res.steps : [];
              const tone = OUTCOME_TONE[c.outcome] ?? "muted";
              const toneColor = tone === "error" ? "var(--error)" : "var(--warning)";
              const reproSteps: any[] = Array.isArray(c.test_case?.steps) ? c.test_case.steps : [];
              return (
                <div
                  key={key}
                  data-testid="runs-report-failure-row"
                  style={{
                    border: `1px solid ${isOpen ? toneColor : "var(--border)"}`,
                    borderRadius: 14,
                    background: "var(--surface)",
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    data-testid="runs-report-failure-toggle-button"
                    onClick={() =>
                      setExpanded((prev) => {
                        const n = new Set(prev);
                        if (n.has(key)) n.delete(key);
                        else n.add(key);
                        return n;
                      })
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      width: "100%",
                      padding: "14px 18px",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "start",
                    }}
                  >
                    <M style={{ color: toneColor, fontWeight: 700 }}>{shortId(cid)}</M>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", flex: 1 }}>{caseTitle(c)}</span>
                    {caseReqChips(c).map((r: any, j: number) => (
                      <M key={j} style={{ fontSize: 10, color: "var(--accent)" }}>
                        {r.external_id ?? r.id}
                      </M>
                    ))}
                    <SeverityBadge severity={c.severity ?? c.test_case?.severity} testId="runs-report-failure-severity-badge" />
                    <Badge tone={tone} testId="runs-report-failure-outcome-badge" state={c.outcome}>{outcomeLabel(c.outcome)}</Badge>
                    <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{isOpen ? "▴" : "▾"}</span>
                  </button>

                  {isOpen && (
                    <div
                      style={{
                        borderTop: "1px solid var(--border)",
                        padding: "16px 18px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 16,
                        background: "var(--surface-2)",
                      }}
                    >
                      {c.failure_reason && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-secondary)" }}>
                            {L.failReason}
                          </div>
                          {renderFailureReason(c.failure_reason)}
                        </div>
                      )}

                      {reproSteps.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-secondary)", marginBottom: 6 }}>
                            {L.stepsRepro}
                          </div>
                          <ol style={{ margin: 0, paddingInlineStart: 20, display: "flex", flexDirection: "column", gap: 4 }}>
                            {reproSteps.map((s: any, j: number) => (
                              <li key={j} style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                                <M style={{ fontSize: 11, color: "var(--text)", whiteSpace: "nowrap" }}>
                                  {(s.method ?? "").toUpperCase()} {s.path}
                                </M>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}

                      {evidenceSteps.map((ev: any, j: number) => (
                        <div key={j} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {ev.request && (
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>
                                {L.request} <M style={{ fontSize: 10 }}>#{j + 1}</M>
                              </div>
                              <JsonBlock value={ev.request} />
                            </div>
                          )}
                          {ev.response && (
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>
                                {L.response}
                                {typeof ev.elapsed_ms === "number" && (
                                  <>
                                    {" — "}
                                    <M style={{ fontSize: 10, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{ev.elapsed_ms} ms</M>
                                  </>
                                )}
                              </div>
                              <JsonBlock value={ev.response} />
                            </div>
                          )}
                          {Array.isArray(ev.assertions) && ev.assertions.length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>{L.evidence}</div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                {ev.assertions.map((a: any, k: number) => (
                                  <div key={k} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                    <span style={{ color: a.passed ? "var(--success)" : "var(--error)", fontSize: 12 }}>
                                      {a.passed ? "✓" : "✗"}
                                    </span>
                                    <Badge tone="muted">
                                      <M style={{ fontSize: 10 }}>{a.type}</M>
                                    </Badge>
                                    {a.path && <M style={{ fontSize: 11, color: "var(--text-secondary)" }}>{a.path}</M>}
                                    {a.op && (
                                      <Badge tone="accent">
                                        <M style={{ fontSize: 10 }}>{a.op}</M>
                                      </Badge>
                                    )}
                                    {a.expected !== undefined && (
                                      <Badge tone="success">
                                        {L.expected}: <M style={{ fontSize: 10 }}>{typeof a.expected === "object" ? JSON.stringify(a.expected) : String(a.expected)}</M>
                                      </Badge>
                                    )}
                                    {a.actual !== undefined && (
                                      <Badge tone={a.passed ? "muted" : "error"}>
                                        {L.actual}: <M style={{ fontSize: 10 }}>{typeof a.actual === "object" ? JSON.stringify(a.actual) : String(a.actual)}</M>
                                      </Badge>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

      {/* All results */}
      {tab === "all" && (
        <Card pad={false}>
          {cases.length === 0 ? (
            <Empty title={L.empty} hint={L.emptyHint} testId="runs-report-results-empty" />
          ) : (
            <Table head={["ID", L.caseCol, L.outcome, L.durationCol, L.reqs]} testId="runs-report-table-root">
              {cases.map((c, i) => (
                <tr key={caseId(c) || i} data-testid="runs-report-result-row">
                  <td>
                    <M style={{ color: "var(--text-secondary)" }}>{shortId(caseId(c))}</M>
                  </td>
                  <td style={{ fontSize: 13, color: "var(--text)" }}>{caseTitle(c)}</td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <StatusDot state={c.outcome} testId="runs-report-result-status-dot" />
                      <Badge tone={OUTCOME_TONE[c.outcome] ?? "muted"} testId="runs-report-result-outcome-badge" state={c.outcome}>{outcomeLabel(c.outcome)}</Badge>
                    </span>
                  </td>
                  <td>
                    <M style={{ color: "var(--text-secondary)" }}>{fmtDur(Number(c.duration_ms) || 0)}</M>
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                      {caseReqChips(c).map((r: any, j: number) => (
                        <M key={j} style={{ fontSize: 10, color: "var(--accent)" }}>
                          {r.external_id ?? r.id}
                        </M>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {/* Compare */}
      {tab === "compare" && (
        <Card title={L.compareWith}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ maxWidth: 420 }}>
              <Select testId="runs-report-compare-select" value={otherRun} onChange={(e: any) => setOtherRun(e.target.value)}>
                <option value="">{L.pickRun}</option>
                {compareRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.display_id ? `#${r.display_id}` : shortId(r.id)} — {fmtDateTime(r.started_at ?? r.created_at)} ({r.state})
                  </option>
                ))}
              </Select>
            </div>

            {compareLoading && <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>…</div>}
            {compareError && <div style={{ color: "var(--error)", fontSize: 13 }}>{compareError}</div>}

            {compare && !compareLoading && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                {typeof compare.coverage_delta === "number" && (
                  <span
                    style={{
                      display: "inline-flex",
                      gap: 6,
                      alignItems: "baseline",
                      border: `1px solid ${compare.coverage_delta >= 0 ? "var(--success)" : "var(--error)"}`,
                      background: compare.coverage_delta >= 0 ? "var(--success-subtle)" : "var(--error-subtle)",
                      color: compare.coverage_delta >= 0 ? "var(--success)" : "var(--error)",
                      borderRadius: 999,
                      padding: "3px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {L.coverageDelta}
                    <M style={{ fontWeight: 700, color: "inherit" }}>
                      {compare.coverage_delta > 0 ? "+" : ""}
                      {compare.coverage_delta}
                    </M>
                    {L.pts}
                  </span>
                )}
                {(typeof compare.unchanged === "number" || Array.isArray(compare.unchanged)) && (
                  <Badge tone="muted">
                    {L.unchanged}{" "}
                    <M style={{ fontSize: 11, fontWeight: 700 }}>
                      {Array.isArray(compare.unchanged) ? compare.unchanged.length : compare.unchanged}
                    </M>
                  </Badge>
                )}
              </div>
            )}

            {compare && !compareLoading && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
                <div
                  style={{
                    border: "1px solid var(--error)",
                    background: "var(--error-subtle, rgba(255,92,114,.16))",
                    borderRadius: 12,
                    padding: "12px 16px",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--error)", marginBottom: 8 }}>
                    {L.newlyFailing} ({newlyFailing.length})
                  </div>
                  {newlyFailing.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{L.noDiff}</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {newlyFailing.map((x, i) => (
                        <div key={i} style={{ fontSize: 13, color: "var(--text)" }}>
                          {compareItemLabel(x)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div
                  style={{
                    border: "1px solid var(--success)",
                    background: "var(--success-subtle, rgba(63,209,121,.16))",
                    borderRadius: 12,
                    padding: "12px 16px",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--success)", marginBottom: 8 }}>
                    {L.newlyPassing} ({newlyPassing.length})
                  </div>
                  {newlyPassing.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{L.noDiff}</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {newlyPassing.map((x, i) => (
                        <div key={i} style={{ fontSize: 13, color: "var(--text)" }}>
                          {compareItemLabel(x)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Performance (FR-044) */}
      {perf.length > 0 && (
        <Card
          title={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {L.perf} <RefChip id="FR-044" />
            </span>
          }
          pad={false}
        >
          <Table head={[L.perfEndpoint, "p50", "p95", "max", L.perfCalls]} testId="runs-report-perf-table">
            {perf.map((p: any, i: number) => (
              <tr key={i}>
                <td>
                  <M style={{ color: "var(--text)", whiteSpace: "nowrap" }}>
                    {(p.method ?? "").toUpperCase()} {p.path}
                  </M>
                </td>
                <td>
                  <M style={{ color: "var(--text-secondary)" }}>{p.p50_ms ?? "—"} ms</M>
                </td>
                <td>
                  <M style={{ color: "var(--text-secondary)" }}>{p.p95_ms ?? "—"} ms</M>
                </td>
                <td>
                  <M style={{ color: "var(--warning)" }}>{p.max_ms ?? "—"} ms</M>
                </td>
                <td>
                  <M style={{ color: "var(--text-secondary)" }}>{p.calls ?? "—"}</M>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
