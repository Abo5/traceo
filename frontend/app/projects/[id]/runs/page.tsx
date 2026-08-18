"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, pollJob } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { Badge, Button, Callout, Card, DateTimeText, Empty, Field, Input, PageHeader, RefChip, Select, SeverityBadge, StatCard, StatusDot, Table, TrendBars, stateTone } from "@/components/ui";

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.runs ?? x?.environments ?? x?.test_cases ?? [];
}

function M({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontFamily: "'JetBrains Mono',ui-monospace,monospace", fontSize: 12, ...style }}>
      {children}
    </span>
  );
}

function shortId(id?: string): string {
  return id ? String(id).slice(0, 8) : "—";
}

const VIEWPORTS = ["1280x800", "1440x900", "1920x1080", "390x844"];

/** The five tracks the scan can build, in the order the design shows them. */
const PIPELINE_TYPES = [
  { v: "functional", label: "Functionality",
    hint: "Every form on the page: are its fields there, and does it enforce its own rules?" },
  { v: "ui", label: "UI",
    hint: "Palette, surfaces and contrast read from a screenshot of the page." },
  { v: "api", label: "API",
    hint: "Every request the page makes becomes an endpoint we can call back." },
  { v: "performance", label: "Performance",
    hint: "The measured load time against a stated budget." },
  { v: "security", label: "Security",
    hint: "Catalogued weakness checks over the endpoints the page revealed." },
] as const;

type PipelineType = (typeof PIPELINE_TYPES)[number]["v"];

/** One line summarising what a pipeline stage did, from its own detail keys. */
function stageDetail(s: any): string {
  if (s.reason) return String(s.reason);
  if (s.stage === "scan") {
    const by = s.cases_by_type ?? {};
    const parts = Object.entries(by)
      .filter(([, n]) => Number(n) > 0)
      .map(([k, n]) => `${n} ${k}`);
    return `${s.forms ?? 0} form(s), ${s.endpoints ?? 0} endpoint(s)` +
      (parts.length ? ` → ${parts.join(", ")}` : "");
  }
  if (s.stage === "generation") return `${s.generated ?? 0} case(s) written, ${s.discarded ?? 0} discarded`;
  if (s.stage === "requirements") {
    const c = s.counts ?? {};
    return c.added !== undefined ? `${c.added} requirement(s) added` : "parsed";
  }
  if (s.cases !== undefined) return `${s.cases} case(s)`;
  return "";
}

export default function RunsPage() {
  const { id } = useParams<{ id: string }>();
  const canDo = useCan();

  const L = {
    title: "Runs",
    sub: "Everything about testing this app: point Traceo at it, pick what to check, run it, fix what failed",
    total: "Total",
    passed: "Passed",
    failed: "Failed",
    errored: "Errored",
    skipped: "Skipped",
    history: "Run history",
    runId: "ID",
    state: "State",
    counts: "Counts",
    started: "Started",
    finished: "Finished",
    initiator: "Initiator",
    noRuns: "No runs yet",
    noRunsHint: "Start a run above — every run this project has ever done lands here",
    loadError: "Failed to load data",
    retry: "Retry",

    // --- the whole-process run ---
    pipelineTitle: "New run",
    step1Title: "What should happen",
    step1Sub: "Optional — a BRD or TRD",
    step2Title: "Your app",
    step2Sub: "The page to test",
    step3Title: "What we'll test",
    step3Sub: "Each type only builds from what the page actually shows — nothing is invented.",
    optional: "optional",
    docNone: "No document",
    docNoneHint: "Without one we test the page against what it declares about itself.",
    docChoose: "Choose file",
    docReplace: "Replace",
    docReading: "Reading…",
    docRead: "Read",
    docRules: "testable rules",
    urlLabel: "App URL",
    urlHint: "Rendered in a real browser, so client-rendered pages are read like any other.",
    viewportLabel: "Viewport",
    typeOne: "type selected",
    typeMany: "types selected",
    pipelineFoot: "Traceo only interacts with this page. Nothing is approved automatically.",
    allowSubmit: "Let forms actually submit",
    allowSubmitOff:
      "Off — a correctly-filled form is submitted, but the request is intercepted and aborted, so nothing is created. Checks that need a real submission are reported as not checked.",
    allowSubmitOn:
      "On — forms will really submit. Only do this against a test environment: it creates data.",
    pipelineStart: "▶ Start the run",
    pipelineRunning: "Running…",
    pipelineStarting: "Starting…",
    foundTitle: "What the run found",
    checksRun: "Checks run",
    acrossRuns: "across this run",
    passedLbl: "Passed",
    needFixing: "Need fixing",
    notChecked: "Not checked",
    notCheckedHint: "no runner implements these yet",
    allPassed: "Every check passed — nothing on this page needs fixing.",
    openReport: "Open full report →",
    fixPrompt: "Fix prompt",
    fixPromptHint: "for Claude · also Cursor, Lovable, Codex",
    copyPrompt: "Copy prompt",
    copied: "Copied ✓",
    stageNames: {
      requirements: "Requirements",
      scan: "Scan",
      generation: "Generation",
      browser_run: "Page checks",
      http_run: "API checks",
    } as Record<string, string>,
  };

  // ---- the whole-process run (target + optional document + test types) ----
  const [pUrl, setPUrl] = useState("");
  const [pViewport, setPViewport] = useState(VIEWPORTS[0]);
  const [pTypes, setPTypes] = useState<Set<PipelineType>>(
    () => new Set<PipelineType>(["functional", "ui", "performance"]));
  const [docId, setDocId] = useState<string | null>(null);
  const [docName, setDocName] = useState<string | null>(null);
  const [docRules, setDocRules] = useState<number | null>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [pipelineJob, setPipelineJob] = useState<{ msg: string; pct: number } | null>(null);
  const [pipelineResult, setPipelineResult] = useState<any | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [allowSubmit, setAllowSubmit] = useState(false);

  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);


  async function loadRuns() {
    const r = await api(`/projects/${id}/runs`);
    setRuns(asList(r));
  }

  function loadAll() {
    setLoading(true);
    setError(null);
    return api(`/projects/${id}/runs`)
      .then((r) => setRuns(asList(r)))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function togglePType(t: PipelineType) {
    setPTypes((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  }

  /**
   * Upload the BRD/TRD and wait for it to be read.
   *
   * The upload route parses on arrival, so waiting here is what lets the step
   * show "12 rules found" before you press Start — and it is why the pipeline
   * reports this stage as `reused` rather than parsing the same file twice.
   */
  async function uploadDoc(file: File) {
    setDocError(null);
    setDocBusy(true);
    setDocName(file.name);
    setDocRules(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api(`/projects/${id}/documents`, { form });
      setDocId(res.document_id ?? null);
      const out = await pollJob(res.job_id);
      const added = Number(out?.added ?? 0);
      const unchanged = Number(out?.unchanged ?? 0);
      setDocRules(added + unchanged);
    } catch (e: any) {
      setDocError(e?.message || String(e));
      setDocId(null);
    } finally {
      setDocBusy(false);
    }
  }

  /** Scan the target, build tests from it, run them, collect fix prompts. */
  async function startPipeline() {
    setPipelineError(null);
    setPipelineResult(null);
    setPipelineJob({ msg: L.pipelineStarting, pct: 2 });
    try {
      const started = await api(`/projects/${id}/pipeline`, {
        body: {
          url: trimmedUrl,
          viewport: pViewport,
          test_types: PIPELINE_TYPES.filter((t) => pTypes.has(t.v)).map((t) => t.v),
          allow_submit: allowSubmit,
          ...(docId ? { document_id: docId } : {}),
        },
      });
      const out = await pollJob(started.job_id, (j) =>
        setPipelineJob({
          msg: j?.message || L.pipelineStarting,
          pct: Math.max(2, Math.round((Number(j?.progress) || 0) * 100)),
        })
      );
      setPipelineResult(out ?? {});
      await loadRuns().catch(() => undefined);
    } catch (e: any) {
      setPipelineError(e?.message || String(e));
    } finally {
      setPipelineJob(null);
    }
  }

  async function copyPrompt(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    } catch {
      /* clipboard unavailable — the prompt is on screen to select by hand */
    }
  }

  const trimmedUrl = pUrl.trim();
  const urlOk = /^https?:\/\/\S+$/i.test(trimmedUrl);
  const pipelineCounts: Record<string, number> = pipelineResult?.counts ?? {};
  const pipelineRuns: any[] = Array.isArray(pipelineResult?.runs) ? pipelineResult.runs : [];
  const pipelinePrompts: any[] = Array.isArray(pipelineResult?.fix_prompts)
    ? pipelineResult.fix_prompts
    : [];

  const runStats = useMemo(() => {
    const ordered = [...runs].reverse();
    const rate = (r: any) => {
      const c = r?.counts ?? {};
      const total = Number(c.total ?? 0);
      return total ? Math.round((Number(c.passed ?? 0) / total) * 100) : 0;
    };
    const latest = runs[0];
    const lc = latest?.counts ?? {};
    return {
      passRate: latest ? rate(latest) : 0,
      failing: Number(lc.failed ?? 0) + Number(lc.errored ?? 0),
      lastLabel: latest
        ? latest.display_id
          ? `#${latest.display_id}`
          : shortId(latest.id)
        : "—",
      lastState: latest?.state ?? null,
      lastWhen: latest?.finished_at ? String(latest.finished_at).slice(0, 10) : "—",
      trend: ordered.map((r) => ({
        display_id: r.display_id,
        coverage_pct: rate(r),
      })),
    };
  }, [runs]);

  return (
    <div data-testid="runs-page-root" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={L.title} sub={L.sub} testId="runs-page-header" />

      {/* stat row + score trend — the design's Runs header */}
      {runs.length > 0 && (
        <>
          <div className="grid-stats">
            <StatCard
              value={runs.length}
              label="Runs"
              hint="in this project"
              testId="runs-total-stat"
            />
            <StatCard
              value={`${runStats.passRate}%`}
              label="Latest pass rate"
              bar={runStats.passRate}
              testId="runs-passrate-stat"
            />
            <StatCard
              value={runStats.lastLabel}
              label="Latest run"
              badge={
                runStats.lastState ? (
                  <Badge tone={stateTone(runStats.lastState)} state={runStats.lastState}>
                    {runStats.lastState}
                  </Badge>
                ) : undefined
              }
              hint={runStats.lastWhen}
              testId="runs-latest-stat"
            />
            <StatCard
              value={runStats.failing}
              label="Failing checks"
              color={runStats.failing > 0 ? "var(--error)" : undefined}
              hint="in the latest run"
              testId="runs-failing-stat"
            />
          </div>

          <Card title="Pass-rate trend" testId="runs-trend-card">
            <TrendBars
              data={runStats.trend}
              height={120}
              testId="runs-trendbars"
            />
          </Card>
        </>
      )}

      {error && (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ color: "var(--error-text)", fontSize: 13 }}>
            {L.loadError} — {error}
          </div>
          <Button variant="secondary" size="sm" onClick={() => loadAll()}>
            {L.retry}
          </Button>
        </div>
      )}

      {/* ============================================================
          New run — the whole process in one place: what should happen
          (optional), where the app lives, what we'll test.
          ============================================================ */}
      {canDo("trigger_run") && (
        <Card title={L.pipelineTitle} testId="runs-pipeline-card">
          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
            {/* left: stepper */}
            <div className="stepper" style={{ width: 210, flexShrink: 0 }}>
              {[
                {
                  n: "1",
                  title: L.step1Title,
                  sub: docName ? `${docName}${docRules !== null ? ` · ${docRules} rules` : ""}` : L.step1Sub,
                  done: !!docId,
                },
                { n: "2", title: L.step2Title, sub: urlOk ? trimmedUrl : L.step2Sub, done: urlOk },
                {
                  n: "3",
                  title: L.step3Title,
                  sub: `${pTypes.size} ${pTypes.size === 1 ? L.typeOne : L.typeMany}`,
                  done: pTypes.size > 0,
                },
              ].map((s, i, all) => (
                <div className="step" key={s.n}>
                  <div className="step-rail">
                    <span className={`step-num ${s.done ? "step-num-done" : i === 0 ? "step-num-current" : ""}`}>
                      {s.done ? "✓" : s.n}
                    </span>
                    {i < all.length - 1 && (
                      <span className={`step-line ${s.done ? "step-line-done" : ""}`} />
                    )}
                  </div>
                  <div className="step-body">
                    <div className={`step-title ${s.done ? "" : "step-title-current"}`}>{s.title}</div>
                    <div className="step-sub">{s.sub}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* right: the three steps */}
            <div style={{ flex: 1, minWidth: 340, display: "flex", flexDirection: "column", gap: 16 }}>
              {/* 1 — requirements (optional) */}
              <div>
                <div className="row" style={{ marginBottom: 8 }}>
                  <b style={{ fontSize: 14 }}>1 · {L.step1Title}</b>
                  <Badge tone="muted">{L.optional}</Badge>
                </div>
                <div className="promptbox" style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <span
                    style={{
                      width: 34, height: 34, borderRadius: 8, background: "var(--blueS)",
                      // --blueD, not --blue: this tile carries text, and --blue
                      // on --blueS is 4.06:1 (axe colour-contrast, AA needs 4.5)
                      color: "var(--blueD)", fontSize: 8.5, fontWeight: 700,
                      display: "grid", placeItems: "center", flexShrink: 0,
                    }}
                    aria-hidden
                  >
                    DOC
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {docName ? (
                      <>
                        <b style={{ fontSize: 12.5, display: "block" }}>{docName}</b>
                        <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                          {docBusy
                            ? L.docReading
                            : docError
                              ? docError
                              : docRules !== null
                                ? `${L.docRead} — ${docRules} ${L.docRules}`
                                : L.docRead}
                        </span>
                      </>
                    ) : (
                      <>
                        <b style={{ fontSize: 12.5, display: "block" }}>{L.docNone}</b>
                        <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                          {L.docNoneHint}
                        </span>
                      </>
                    )}
                  </div>
                  <label className="btn btn-secondary btn-sm" style={{ cursor: "pointer" }}>
                    {docName ? L.docReplace : L.docChoose}
                    <input
                      type="file"
                      accept=".pdf,.docx,.md,.txt"
                      style={{ display: "none" }}
                      data-testid="runs-pipeline-doc-input"
                      disabled={docBusy || !!pipelineJob}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadDoc(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>

              {/* 2 — the app */}
              <div>
                <b style={{ fontSize: 14, display: "block", marginBottom: 8 }}>2 · {L.step2Title}</b>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <Field label={L.urlLabel} hint={L.urlHint} testId="runs-pipeline-url-input">
                      <Input
                        type="url"
                        inputMode="url"
                        placeholder="https://example.com/login"
                        value={pUrl}
                        disabled={!!pipelineJob}
                        onChange={(e) => setPUrl(e.target.value)}
                      />
                    </Field>
                  </div>
                  <div style={{ width: 160 }}>
                    <Field label={L.viewportLabel} testId="runs-pipeline-viewport-select">
                      <Select
                        value={pViewport}
                        disabled={!!pipelineJob}
                        onChange={(e: any) => setPViewport(e.target.value)}
                      >
                        {VIEWPORTS.map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </div>
              </div>

              {/* 3 — what we'll test */}
              <div>
                <b style={{ fontSize: 14, display: "block", marginBottom: 2 }}>3 · {L.step3Title}</b>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8 }}>
                  {L.step3Sub}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
                    gap: 10,
                  }}
                >
                  {PIPELINE_TYPES.map((t) => {
                    const on = pTypes.has(t.v);
                    return (
                      <label
                        key={t.v}
                        data-testid={`runs-pipeline-type-${t.v}`}
                        data-state={on ? "on" : "off"}
                        style={{
                          display: "flex", gap: 10, alignItems: "flex-start",
                          border: `1px solid ${on ? "var(--blue)" : "var(--border)"}`,
                          background: on ? "var(--blueS)" : "var(--surface)",
                          borderRadius: "var(--r-lg)", padding: "10px 12px", cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!!pipelineJob}
                          onChange={() => togglePType(t.v)}
                          style={{ marginTop: 2 }}
                        />
                        <span style={{ minWidth: 0 }}>
                          <b style={{ fontSize: 12.5, display: "block" }}>{t.label}</b>
                          <span style={{ fontSize: 10.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                            {t.hint}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {pipelineError && (
                <div className="error-text" data-testid="runs-pipeline-error-text">
                  {pipelineError}
                </div>
              )}

              {/* Submitting a correctly-filled form creates data on the target,
                  so it is off unless you say otherwise. With it off the runner
                  intercepts and aborts the request instead. */}
              <label
                className="promptbox"
                style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={allowSubmit}
                  disabled={!!pipelineJob}
                  onChange={(e) => setAllowSubmit(e.target.checked)}
                  data-testid="runs-pipeline-allow-submit"
                  style={{ marginTop: 2 }}
                />
                <span>
                  <b style={{ fontSize: 12.5, display: "block" }}>{L.allowSubmit}</b>
                  <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                    {allowSubmit ? L.allowSubmitOn : L.allowSubmitOff}
                  </span>
                </span>
              </label>

              <div className="row" style={{ gap: 10 }}>
                <span style={{ fontSize: 10.5, color: "var(--text-secondary)", flex: 1 }}>
                  {L.pipelineFoot}
                </span>
                <Button
                  onClick={startPipeline}
                  disabled={!urlOk || pTypes.size === 0 || !!pipelineJob}
                  testId="runs-pipeline-start-button"
                >
                  {pipelineJob ? L.pipelineRunning : L.pipelineStart}
                </Button>
              </div>

              {pipelineJob && (
                <div
                  className="card"
                  data-testid="runs-pipeline-progress"
                  style={{
                    border: "1.5px solid var(--blue)",
                    padding: "16px 18px",
                    display: "flex", flexDirection: "column", gap: 12,
                  }}
                >
                  <div className="row" style={{ gap: 10 }}>
                    <span className="dot d-blue" aria-hidden />
                    <b style={{ fontSize: 14, flex: 1 }}>{pipelineJob.msg}</b>
                    <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: "var(--blueD)" }}>
                      {pipelineJob.pct}%
                    </span>
                  </div>
                  <div
                    className="bar"
                    style={{ height: 8 }}
                    role="progressbar"
                    aria-label="Test run progress"
                    aria-valuenow={pipelineJob.pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <i style={{ width: `${pipelineJob.pct}%`,
                                background: "linear-gradient(90deg, var(--blue), var(--violet))" }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* ---------- what the run found ---------- */}
      {pipelineResult && (
        <Card
          title={L.foundTitle}
          action={
            pipelineRuns.length > 0 ? (
              <Link
                href={`/projects/${id}/runs/${pipelineRuns[0].run_id}`}
                className="link"
                style={{ fontSize: 11.5 }}
              >
                {L.openReport}
              </Link>
            ) : undefined
          }
          testId="runs-pipeline-result-card"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="grid-stats">
              <StatCard value={pipelineCounts.total ?? 0} label={L.checksRun}
                        hint={L.acrossRuns} testId="runs-pipeline-total-stat" />
              <StatCard value={pipelineCounts.passed ?? 0} label={L.passedLbl}
                        color="var(--success-text)" testId="runs-pipeline-passed-stat" />
              <StatCard value={pipelineCounts.failed ?? 0} label={L.needFixing}
                        color={(pipelineCounts.failed ?? 0) > 0 ? "var(--error-text)" : undefined}
                        testId="runs-pipeline-failed-stat" />
              {(pipelineCounts.skipped ?? 0) > 0 && (
                <StatCard value={pipelineCounts.skipped} label={L.notChecked}
                          hint={L.notCheckedHint} testId="runs-pipeline-skipped-stat" />
              )}
            </div>

            {/* what each stage did — a skipped stage must say why */}
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {(pipelineResult.stages ?? []).map((s: any, i: number) => (
                <div key={s.stage}>
                  {i > 0 && <div className="hr" />}
                  <div className="row" style={{ gap: 10, padding: "9px 0", flexWrap: "nowrap" }}>
                    <Badge
                      tone={s.status === "completed" ? "success"
                        : s.status === "failed" ? "error"
                          : s.status === "reused" ? "info" : "muted"}
                      state={s.status}
                    >
                      {s.status}
                    </Badge>
                    <b style={{ fontSize: 12.5, width: 110 }}>
                      {L.stageNames[s.stage] ?? s.stage}
                    </b>
                    <span style={{
                      flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--text-secondary)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {stageDetail(s)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {pipelinePrompts.length === 0 ? (
              <Callout tone="success" testId="runs-pipeline-clean-callout">
                {L.allPassed}
              </Callout>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {pipelinePrompts.map((p: any, i: number) => {
                  const key = p.test_case_id ?? String(i);
                  const tone = p.severity === "critical" ? "error"
                    : p.severity === "major" ? "warning" : "info";
                  return (
                    <div
                      key={key}
                      className={`card card-striped card-striped-${tone}`}
                      data-testid="runs-pipeline-failure-card"
                      style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}
                    >
                      <div className="row" style={{ gap: 10 }}>
                        <SeverityBadge severity={p.severity} />
                        <b style={{ fontSize: 13.5, flex: 1, minWidth: 200 }}>{p.title}</b>
                        <RefChip id={String(key).slice(0, 8)} />
                      </div>
                      <div className="promptbox">
                        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                          <span className="klabel" style={{ color: "var(--accent-text)" }}>
                            {L.fixPrompt}
                          </span>
                          <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                            {L.fixPromptHint}
                          </span>
                          <Button size="sm" testId="runs-pipeline-copy-button"
                                  onClick={() => copyPrompt(key, p.prompt)}>
                            {copied === key ? L.copied : L.copyPrompt}
                          </Button>
                        </div>
                        <pre className="mono" style={{
                          margin: 0, fontSize: 10.5, lineHeight: 1.7,
                          color: "var(--text-secondary)", whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}>
                          {p.prompt}
                        </pre>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* The "run approved cases against an environment" launcher lived here.
          It went with the Environments and Review pages: without them a user can
          neither configure a target for it nor approve a case to feed it.
          Running is the wizard above, which builds its own cases and derives its
          own environment from the URL. */}

      {/* History */}
      <Card title={L.history} pad={false}>
        {loading ? (
          <div style={{ padding: 24, color: "var(--text-secondary)", fontSize: 13 }}>…</div>
        ) : runs.length === 0 ? (
          <Empty title={L.noRuns} hint={L.noRunsHint} testId="runs-empty-state" />
        ) : (
          <Table head={[L.runId, L.state, L.counts, L.started, L.finished, L.initiator]} testId="runs-table-root">
            {runs.map((r) => {
              const c = r.counts ?? {};
              return (
                <tr key={r.id} data-testid="runs-row">
                  <td>
                    <Link href={`/projects/${id}/runs/${r.id}`} data-testid="runs-row-link" style={{ textDecoration: "none" }}>
                      <M style={{ color: "var(--accent-text)" }}>{r.display_id ? `#${r.display_id}` : shortId(r.id)}</M>
                    </Link>
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <StatusDot state={r.state} testId="runs-row-status-dot" />
                      <Badge tone={stateTone(r.state)} testId="runs-row-state-badge" state={r.state}>{r.state}</Badge>
                    </span>
                  </td>
                  <td>
                    <M>
                      <span style={{ color: "var(--success-text)" }}>{c.passed ?? 0}</span>
                      {" / "}
                      <span style={{ color: "var(--error-text)" }}>{c.failed ?? 0}</span>
                      {" / "}
                      <span style={{ color: "var(--warning-text)" }}>{c.errored ?? 0}</span>
                    </M>
                  </td>
                  <td>
                    <DateTimeText value={r.started_at ?? r.created_at} style={{ color: "var(--text-secondary)" }} />
                  </td>
                  <td>
                    <DateTimeText value={r.finished_at} style={{ color: "var(--text-secondary)" }} />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {r.initiator?.name ?? r.initiated_by_name ?? r.initiated_by ?? r.created_by ?? "—"}
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
