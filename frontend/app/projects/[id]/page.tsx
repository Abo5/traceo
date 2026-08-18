"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import {
  Badge,
  Button,
  Callout,
  Card,
  Donut,
  Meter,
  Mono,
  PageHeader,
  RefChip,
  SeverityBadge,
  StatCard,
  StatusDot,
  TrendBars,
  stateTone,
} from "@/components/ui";
import { useProject } from "@/lib/project-context";
import { TEST_TYPES, projectTestTypes, type TestType } from "@/lib/test-types";
import { TestTypePicker } from "@/components/test-type-picker";

type Dashboard = {
  requirement_count: number;
  confirmed_count: number;
  test_case_counts: Record<string, number>;
  coverage_pct: number;
  latest_run: {
    id: string;
    display_id?: number;
    state: string;
    started_at?: string | null;
    finished_at?: string | null;
    counts?: Record<string, number>;
  } | null;
  trend?: {
    run_id: string;
    display_id?: number;
    coverage_pct?: number;
    passed?: number;
    failed?: number;
    errored?: number;
  }[];
  regression_watch?: {
    test_case_id: string;
    title: string;
    requirement_external_ids?: string[];
    run_id: string;
    outcome: string;
    severity?: string;
  }[];
  gaps_detail?: {
    requirement_id: string;
    external_id?: string;
    reason?: string;
    next_action?: string;
  }[];
  open_defects?: { total: number; critical: number };
  median_duration_ms?: number | null;
};

const PIPELINE_COLORS = [
  "var(--blue)",
  "var(--violet)",
  "var(--pink)",
  "var(--warning)",
  "var(--success)",
];

const TC_STATES = ["draft", "approved", "rejected", "stale", "archived"] as const;

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.runs ?? [];
}

/** "8 min ago" / "yesterday" / a date — the design's relative run stamp. */
function relative(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return String(iso);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  return new Date(t).toISOString().slice(0, 10);
}

export default function ProjectDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const { project, refresh } = useProject();
  const canDo = useCan();

  const L = {
    title: "Overview",
    sub: "From requirement to executed test — project status now",
    coverage: "Coverage",
    approved: "Approved cases",
    latestRun: "Latest run",
    openDefects: "Open defects",
    medianDur: "Median run",
    decisions: "Needs your decision",
    decisionsEmpty: "Nothing is waiting on you — no regressions and no coverage gaps.",
    recentRuns: "Recent runs",
    allRuns: "All runs →",
    trendTitle: "Coverage trend",
    breakdown: "Coverage breakdown",
    regTitle: "Regression watch",
    gapsTitle: "Coverage gaps",
    caseStates: "Test cases by state",
    quick: "Quick actions",
    noRuns: "No runs yet",
    openReport: "Open report",
    coverIt: "Run it →",
    gapReasons: {
      no_reachable_endpoint: "No matching endpoint",
      all_cases_disabled: "No approved cases (links exist)",
      no_approved_cases: "No approved cases",
      unmappable: "Could not map to an endpoint",
    } as Record<string, string>,
    uploadDoc: "Upload requirements doc",
    goRun: "New run",
    pipeline: "Pipeline",
    steps: [
      "Requirements analysis",
      "Endpoint discovery",
      "Grounded generation",
      "Human review",
      "Execution & traceability",
    ],
    stateNames: {
      draft: "Draft",
      approved: "Approved",
      rejected: "Rejected",
      stale: "Stale",
      archived: "Archived",
    } as Record<string, string>,
    passed: "Passed",
    failed: "Failed",
    errored: "Errored",
    loop: "Approve cases, run them, close the gaps — the coverage number goes up. That's the loop.",
    loadError: "Failed to load the project dashboard",
    retry: "Retry",
    loading: "Loading…",
  };

  const [dash, setDash] = useState<Dashboard | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ---- test types: what this project is for ----
  const declared = projectTestTypes(project);
  const [draftTypes, setDraftTypes] = useState<TestType[] | null>(null);
  const [savingTypes, setSavingTypes] = useState(false);
  const [typesError, setTypesError] = useState<string | null>(null);
  const shownTypes = draftTypes ?? declared;
  const typesDirty =
    draftTypes !== null && draftTypes.join(",") !== declared.join(",");

  function toggleType(type: TestType) {
    setTypesError(null);
    setDraftTypes((current) => {
      const base = current ?? declared;
      return base.includes(type)
        ? base.filter((t) => t !== type)
        : TEST_TYPES.filter((t) => t === type || base.includes(t));
    });
  }

  async function saveTypes() {
    if (!draftTypes) return;
    setSavingTypes(true);
    setTypesError(null);
    try {
      await api(`/projects/${id}`, { method: "PATCH", body: { test_types: draftTypes } });
      await refresh();
      setDraftTypes(null);
    } catch (e: any) {
      setTypesError(e?.message || String(e));
    } finally {
      setSavingTypes(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDash(await api<Dashboard>(`/projects/${id}/dashboard`));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api<any>(`/projects/${id}/runs`);
        if (alive) setRuns(asList(res).slice(0, 5));
      } catch {
        /* the runs page surfaces its own error */
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  const base = `/projects/${id}`;
  const totalCases = dash
    ? Object.values(dash.test_case_counts ?? {}).reduce((a, b) => a + (b || 0), 0)
    : 0;
  const run = dash?.latest_run ?? null;
  const counts = run?.counts ?? {};
  const trend = dash?.trend ?? [];
  const regressions = dash?.regression_watch ?? [];
  const gaps = dash?.gaps_detail ?? [];
  const defects = dash?.open_defects ?? { total: 0, critical: 0 };
  const medianSec =
    dash?.median_duration_ms != null ? (dash.median_duration_ms / 1000).toFixed(1) + "s" : "—";
  const runLabel = run?.display_id ? `#${run.display_id}` : run ? run.id.slice(0, 8) : "—";
  const approved = dash?.test_case_counts?.approved ?? 0;
  const runTotal = Number(counts.total ?? 0);
  const passRate = runTotal ? (Number(counts.passed ?? 0) / runTotal) * 100 : 0;
  const decisionCount = regressions.length + gaps.length;

  return (
    <div className="stack" data-testid="dashboard-page-root">
      <PageHeader
        title={project?.name ?? L.title}
        sub={
          run
            ? `Run ${runLabel} ${relative(run.finished_at ?? run.started_at)} — everything below is up to date.`
            : L.sub
        }
        testId="dashboard-page-header"
        actions={
          <span className="pill" style={{ cursor: "default" }}>
            {new Date().toDateString().slice(0, 10)}
          </span>
        }
      />

      {/* What this project is for — the five test types, editable here. */}
      <Card title="Test types" testId="project-types-card">
        <div className="stack" style={{ gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            The kinds of testing this project runs. Narrowing it narrows what every
            engine here produces — a type that is off is refused, not silently skipped.
          </div>
          <TestTypePicker
            selected={shownTypes}
            onToggle={toggleType}
            disabled={!canDo("manage_projects") || savingTypes}
            testIdPrefix="project-type"
          />
          {typesError && (
            <div className="error-text" data-testid="project-types-error-text">
              {typesError}
            </div>
          )}
          {!canDo("manage_projects") ? (
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}
                 data-testid="project-types-readonly-hint">
              Changing this needs the manage_projects capability.
            </div>
          ) : typesDirty ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Button
                variant="primary"
                size="sm"
                testId="project-types-save-button"
                disabled={savingTypes || shownTypes.length === 0}
                onClick={saveTypes}
              >
                {savingTypes ? "Saving…" : "Save test types"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                testId="project-types-cancel-button"
                disabled={savingTypes}
                onClick={() => {
                  setDraftTypes(null);
                  setTypesError(null);
                }}
              >
                Cancel
              </Button>
              {shownTypes.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--warning)" }}
                      data-testid="project-types-empty-hint">
                  Pick at least one.
                </span>
              )}
            </div>
          ) : null}
        </div>
      </Card>

      {error ? (
        <Card testId="dashboard-error-card">
          <div className="stack" style={{ gap: 10, alignItems: "flex-start" }}>
            <div className="error-text" data-testid="dashboard-error-text">
              {L.loadError} — {error}
            </div>
            <Button variant="secondary" size="sm" testId="dashboard-retry-button" onClick={load}>
              {L.retry}
            </Button>
          </div>
        </Card>
      ) : loading || !dash ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{L.loading}</div>
      ) : (
        <>
          {/* ---- stat row ---- */}
          <div className="grid-stats">
            <div style={{ position: "relative" }}>
              <StatCard
                value={`${dash.coverage_pct}%`}
                label={L.coverage}
                bar={dash.coverage_pct}
                testId="dashboard-coverage-stat"
              />
              <span style={{ position: "absolute", top: 12, right: 12 }}>
                <RefChip id="FR-050" />
              </span>
            </div>
            <StatCard
              value={approved}
              label={L.approved}
              hint={`of ${totalCases} test cases`}
              testId="dashboard-approved-cases-stat"
            />
            <StatCard
              value={run ? `${counts.passed ?? 0} / ${counts.total ?? 0}` : "—"}
              label={`${L.latestRun} ${runLabel}`}
              badge={
                run ? (
                  <Badge tone={stateTone(run.state)} state={run.state}>
                    {run.state}
                  </Badge>
                ) : undefined
              }
              hint={run ? relative(run.finished_at ?? run.started_at) : L.noRuns}
              testId="dashboard-latest-run-stat"
            />
            <div style={{ position: "relative" }}>
              <StatCard
                value={defects.total}
                label={L.openDefects}
                color={defects.total > 0 ? "var(--error)" : undefined}
                badge={
                  defects.critical > 0 ? (
                    <Badge tone="error">{defects.critical} critical</Badge>
                  ) : undefined
                }
                hint={defects.total === 0 ? "nothing open" : `${defects.critical} critical`}
                testId="dashboard-open-defects-stat"
              />
              <span style={{ position: "absolute", top: 12, right: 12 }}>
                <RefChip id="FR-052" />
              </span>
            </div>
            <StatCard
              value={medianSec}
              label={L.medianDur}
              hint="median duration"
              testId="dashboard-median-duration-stat"
            />
          </div>

          {/* ---- two-column body ---- */}
          <div className="dash-cols">
            <div className="stack" style={{ gap: 20, minWidth: 0 }}>
              {/* needs your decision — regressions and gaps in one queue */}
              <Card
                title={L.decisions}
                action={
                  decisionCount > 0 ? (
                    <Link href={`${base}/requirements`} className="link" style={{ fontSize: 11.5 }}>
                      View all ({decisionCount}) →
                    </Link>
                  ) : undefined
                }
                testId="dashboard-regression-card"
              >
                {decisionCount === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--success-text)" }}>
                    {L.decisionsEmpty}
                  </div>
                ) : (
                  <div>
                    {regressions.slice(0, 5).map((r, i) => (
                      <div key={r.test_case_id}>
                        {i > 0 && <div className="hr" />}
                        <div
                          className="row"
                          data-testid="dashboard-regression-row"
                          style={{ gap: 12, padding: "11px 0", flexWrap: "nowrap" }}
                        >
                          <SeverityBadge
                            severity={r.severity}
                            testId="dashboard-regression-severity-badge"
                          />
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontSize: 13,
                              fontWeight: 500,
                            }}
                            title={r.title}
                          >
                            {r.title}
                          </span>
                          {(r.requirement_external_ids ?? []).slice(0, 1).map((x) => (
                            <RefChip key={x} id={x} />
                          ))}
                          <Link href={`${base}/runs/${r.run_id}`}>
                            <Badge
                              tone={r.outcome === "failed" ? "error" : "warning"}
                              testId="dashboard-regression-outcome-badge"
                              state={r.outcome}
                            >
                              {r.outcome}
                            </Badge>
                          </Link>
                        </div>
                      </div>
                    ))}
                    {gaps.slice(0, 4).map((g, i) => (
                      <div key={g.requirement_id}>
                        {(i > 0 || regressions.length > 0) && <div className="hr" />}
                        <div
                          className="row"
                          data-testid="dashboard-gap-row"
                          style={{ gap: 12, padding: "11px 0", flexWrap: "nowrap" }}
                        >
                          <Badge tone="warning">GAP</Badge>
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 13,
                              fontWeight: 500,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={g.next_action ?? undefined}
                          >
                            {L.gapReasons[g.reason ?? ""] ?? g.reason ?? "Uncovered requirement"}
                          </span>
                          <RefChip id={g.external_id || g.requirement_id.slice(0, 8)} />
                          <Link
                            href={`${base}/runs`}
                            className="link"
                            style={{ fontSize: 11.5 }}
                            data-testid="dashboard-gap-run-button"
                          >
                            {L.coverIt}
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {/* recent runs */}
              <Card
                title={L.recentRuns}
                action={
                  <Link href={`${base}/runs`} className="link" style={{ fontSize: 11.5 }}>
                    {L.allRuns}
                  </Link>
                }
                testId="dashboard-recent-runs-card"
              >
                {runs.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{L.noRuns}</div>
                ) : (
                  <div>
                    <div
                      className="mono"
                      style={{
                        display: "flex",
                        gap: 12,
                        fontSize: 9,
                        letterSpacing: "0.08em",
                        color: "var(--text-secondary)",
                        padding: "6px 0",
                        textTransform: "uppercase",
                      }}
                    >
                      <span style={{ width: 80 }}>Run</span>
                      <span style={{ width: 110 }}>When</span>
                      <span style={{ width: 90 }}>Checks</span>
                      <span style={{ flex: 1 }} />
                      <span>Status</span>
                    </div>
                    {runs.map((r, i) => {
                      const c = r?.counts ?? {};
                      return (
                        <div key={r.id ?? i}>
                          {i > 0 && <div className="hr" />}
                          <Link
                            href={`${base}/runs/${r.id}`}
                            data-testid="dashboard-recent-run-row"
                            style={{
                              display: "flex",
                              gap: 12,
                              alignItems: "center",
                              padding: "10px 0",
                            }}
                          >
                            <Mono style={{ width: 80, fontSize: 11.5, color: "var(--text-secondary)" }}>
                              {r.display_id ? `#${r.display_id}` : String(r.id ?? "").slice(0, 8)}
                            </Mono>
                            <span style={{ width: 110, fontSize: 11.5, color: "var(--text-secondary)" }}>
                              {relative(r.finished_at ?? r.started_at)}
                            </span>
                            <Mono style={{ width: 90, fontSize: 11.5, color: "var(--text-secondary)" }}>
                              {c.passed ?? 0}/{c.total ?? 0}
                            </Mono>
                            <span style={{ flex: 1 }} />
                            <Badge tone={stateTone(r.state)} state={r.state}>
                              {r.state}
                            </Badge>
                          </Link>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>

              {/* coverage trend */}
              <Card
                title={L.trendTitle}
                action={<RefChip id="FR-054" />}
                testId="dashboard-coverage-trend-card"
              >
                {trend.length > 0 ? (
                  <TrendBars data={trend} height={130} testId="dashboard-coverage-trendbars" />
                ) : (
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{L.noRuns}</div>
                )}
              </Card>
            </div>

            {/* ---- right rail ---- */}
            <div className="stack" style={{ gap: 20 }}>
              <Card title={L.latestRun} testId="dashboard-latest-run-card">
                {run ? (
                  <div className="stack" style={{ gap: 14 }}>
                    <div className="row" style={{ gap: 16, alignItems: "center" }}>
                      <Donut
                        passed={counts.passed ?? 0}
                        failed={counts.failed ?? 0}
                        errored={counts.errored ?? 0}
                        size={84}
                        testId="dashboard-latest-run-donut"
                      />
                      <div className="stack" style={{ gap: 8 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <Badge
                            tone={stateTone(run.state)}
                            testId="dashboard-latest-run-state-badge"
                            state={run.state}
                          >
                            {run.state}
                          </Badge>
                          <Mono style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            {runLabel}
                          </Mono>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.8 }}>
                          <span style={{ color: "var(--success-text)" }}>
                            {counts.passed ?? 0} {L.passed}
                          </span>
                          {" · "}
                          <span style={{ color: "var(--error-text)" }}>
                            {counts.failed ?? 0} {L.failed}
                          </span>
                          {" · "}
                          <span style={{ color: "var(--warning-text)" }}>
                            {counts.errored ?? 0} {L.errored}
                          </span>
                        </div>
                      </div>
                    </div>
                    <Link href={`${base}/runs/${run.id}`}>
                      <Button
                        variant="secondary"
                        size="sm"
                        testId="dashboard-open-report-button"
                      >
                        {L.openReport}
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{L.noRuns}</div>
                )}
              </Card>

              <Card title={L.breakdown} testId="dashboard-breakdown-card">
                <div className="stack" style={{ gap: 14 }}>
                  <Meter
                    label="Requirements covered"
                    value={`${dash.coverage_pct}%`}
                    pct={dash.coverage_pct}
                  />
                  <Meter
                    label="Cases approved"
                    value={`${approved}/${totalCases}`}
                    pct={totalCases ? (approved / totalCases) * 100 : 0}
                  />
                  <Meter
                    label="Latest run passing"
                    value={runTotal ? `${Math.round(passRate)}%` : "—"}
                    pct={passRate}
                  />
                </div>
              </Card>

              {/* quick actions */}
              {(canDo("upload_documents") || canDo("trigger_run")) && (
                <Card title={L.quick} testId="dashboard-quick-actions-card">
                  <div className="row" style={{ gap: 8 }}>
                    {canDo("upload_documents") && (
                      <Link href={`${base}/requirements`}>
                        <Button
                          variant="secondary"
                          size="sm"
                          testId="dashboard-quick-upload-doc-button"
                        >
                          {L.uploadDoc}
                        </Button>
                      </Link>
                    )}
                    {canDo("trigger_run") && (
                      <Link href={`${base}/runs`}>
                        <Button variant="primary" size="sm" testId="dashboard-quick-run-button">
                          {L.goRun}
                        </Button>
                      </Link>
                    )}
                  </div>
                </Card>
              )}

              {/* coverage gaps detail — kept as its own card for the gap workflow */}
              <Card
                title={L.gapsTitle}
                action={<RefChip id="FR-051" />}
                testId="dashboard-gaps-card"
              >
                {gaps.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--success-text)" }}>
                    No gaps — every confirmed requirement has an approved case
                  </div>
                ) : (
                  <div className="stack" style={{ gap: 8 }}>
                    {gaps.slice(0, 6).map((g) => (
                      <div
                        key={g.requirement_id}
                        className="promptbox"
                        style={{ background: "var(--warnS)" }}
                      >
                        <div className="row" style={{ gap: 8 }}>
                          <RefChip id={g.external_id || g.requirement_id.slice(0, 8)} />
                          <span style={{ fontSize: 12, color: "var(--warning-text)" }}>
                            {L.gapReasons[g.reason ?? ""] ?? g.reason}
                          </span>
                        </div>
                        {g.next_action && (
                          <div
                            style={{
                              fontSize: 11.5,
                              color: "var(--text-secondary)",
                              marginBlockStart: 4,
                            }}
                          >
                            {g.next_action}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>

          {/* case-state chips */}
          <Card title={L.caseStates} testId="dashboard-case-states-card">
            <div className="row" style={{ gap: 10 }}>
              {TC_STATES.map((s) => (
                <span
                  key={s}
                  data-testid={`dashboard-case-state-${s}-chip`}
                  data-state={s}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "var(--chip)",
                    borderRadius: "var(--r-pill)",
                    padding: "6px 14px",
                    fontSize: 12.5,
                  }}
                >
                  <StatusDot state={s} />
                  <span style={{ color: "var(--text-secondary)" }}>{L.stateNames[s]}</span>
                  <Mono style={{ fontSize: 12, fontWeight: 700 }}>
                    {dash.test_case_counts?.[s] ?? 0}
                  </Mono>
                </span>
              ))}
            </div>
          </Card>

          {/* pipeline strip */}
          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              {L.pipeline}
            </div>
            <div className="pipeline-strip">
              {L.steps.map((step, i) => (
                <div className="pipeline-step" key={i}>
                  <span
                    className="pipeline-num"
                    style={{
                      color: PIPELINE_COLORS[i],
                      background: "var(--canvas)",
                      border: `1px solid ${PIPELINE_COLORS[i]}`,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span className="pipeline-label">{step}</span>
                </div>
              ))}
            </div>
          </div>

          <Callout testId="dashboard-loop-callout">{L.loop}</Callout>
        </>
      )}
    </div>
  );
}
