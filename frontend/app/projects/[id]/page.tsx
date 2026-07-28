"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import {
  Badge,
  Button,
  Card,
  Donut,
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
  "var(--c-amber)",
  "var(--c-pink)",
  "var(--c-violet)",
  "var(--c-blue)",
  "var(--c-cyan)",
];

const TC_STATES = ["draft", "approved", "rejected", "stale", "archived"] as const;

export default function ProjectDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useLang();
  const ar = lang === "ar";
  const { project } = useProject();

  const L = ar
    ? {
        title: "نظرة عامة",
        sub: "من المتطلب إلى الاختبار المنفّذ — حالة المشروع الآن",
        reqs: "المتطلبات",
        confirmed: "المؤكدة",
        cases: "حالات الاختبار",
        coverage: "التغطية %",
        caseStates: "حالات الاختبار حسب الحالة",
        latestRun: "آخر تشغيل",
        noRuns: "لا توجد تشغيلات بعد",
        viewRun: "عرض التقرير",
        openDefects: "عيوب مفتوحة",
        criticalOf: "حرجة",
        medianDur: "وسيط مدة التشغيل",
        trendTitle: "اتجاه التغطية",
        regTitle: "مراقبة الانحدار",
        regEmpty: "لا انحدارات — كل ما نجح سابقاً ما زال ينجح",
        gapsTitle: "فجوات التغطية",
        gapsEmpty: "لا فجوات — كل متطلب مؤكد له حالة معتمدة",
        targetedGen: "توليد مستهدف",
        openReport: "فتح التقرير",
        gapReasons: {
          no_reachable_endpoint: "لا توجد واجهة مطابقة",
          all_cases_disabled: "لا حالات معتمدة (روابط موجودة)",
          no_approved_cases: "لا حالات معتمدة",
          unmappable: "تعذّر الربط بواجهة",
        } as Record<string, string>,
        quick: "إجراءات سريعة",
        uploadDoc: "رفع مستند متطلبات",
        importSpec: "استيراد مواصفة API",
        goGenerate: "توليد حالات",
        goReview: "المراجعة",
        goRun: "تشغيل جديد",
        pipeline: "خط المعالجة",
        steps: [
          "تحليل المتطلبات",
          "اكتشاف الواجهات",
          "التوليد المقيّد",
          "المراجعة البشرية",
          "التنفيذ والتتبّع",
        ],
        stateNames: {
          draft: "مسودة",
          approved: "معتمدة",
          rejected: "مرفوضة",
          stale: "قديمة",
          archived: "مؤرشفة",
        } as Record<string, string>,
        passed: "ناجح",
        failed: "فاشل",
        errored: "خطأ",
        total: "الإجمالي",
        loadError: "تعذّر تحميل لوحة المشروع",
        retry: "إعادة المحاولة",
        loading: "جارٍ التحميل…",
      }
    : {
        title: "Overview",
        sub: "From requirement to executed test — project status now",
        reqs: "Requirements",
        confirmed: "Confirmed",
        cases: "Test cases",
        coverage: "Coverage %",
        caseStates: "Test cases by state",
        latestRun: "Latest run",
        noRuns: "No runs yet",
        viewRun: "View report",
        openDefects: "Open defects",
        criticalOf: "critical",
        medianDur: "Median run duration",
        trendTitle: "Coverage trend",
        regTitle: "Regression watch",
        regEmpty: "No regressions — everything that passed still passes",
        gapsTitle: "Coverage gaps",
        gapsEmpty: "No gaps — every confirmed requirement has an approved case",
        targetedGen: "Targeted generation",
        openReport: "Open report",
        gapReasons: {
          no_reachable_endpoint: "No matching endpoint",
          all_cases_disabled: "No approved cases (links exist)",
          no_approved_cases: "No approved cases",
          unmappable: "Could not map to an endpoint",
        } as Record<string, string>,
        quick: "Quick actions",
        uploadDoc: "Upload requirements doc",
        importSpec: "Import API spec",
        goGenerate: "Generate cases",
        goReview: "Review",
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
        total: "Total",
        loadError: "Failed to load the project dashboard",
        retry: "Retry",
        loading: "Loading…",
      };

  const [dash, setDash] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="stack">
      <PageHeader title={project?.name ?? L.title} sub={L.sub} />

      {error ? (
        <Card>
          <div className="stack" style={{ gap: 10, alignItems: "flex-start" }}>
            <div className="error-text">
              {L.loadError} — {error}
            </div>
            <Button variant="secondary" size="sm" onClick={load}>
              {L.retry}
            </Button>
          </div>
        </Card>
      ) : loading || !dash ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{L.loading}</div>
      ) : (
        <>
          {/* KPI row — v2 */}
          <div className="grid-stats">
            <div style={{ position: "relative" }}>
              <StatCard value={`${dash.coverage_pct}%`} label={L.coverage} color="var(--accent)" />
              <span style={{ position: "absolute", top: 10, insetInlineEnd: 10 }}>
                <RefChip id="FR-050" />
              </span>
            </div>
            <StatCard
              value={dash.test_case_counts?.approved ?? 0}
              label={L.stateNames.approved}
              color="var(--success)"
            />
            <StatCard
              value={run ? `${counts.passed ?? 0}/${counts.total ?? 0}` : "—"}
              label={`${L.latestRun} ${runLabel}`}
              color="var(--c-blue)"
            />
            <div style={{ position: "relative" }}>
              <StatCard
                value={defects.total}
                label={`${L.openDefects} · ${defects.critical} ${L.criticalOf}`}
                color={defects.critical > 0 ? "var(--error)" : "var(--text)"}
              />
              <span style={{ position: "absolute", top: 10, insetInlineEnd: 10 }}>
                <RefChip id="FR-052" />
              </span>
            </div>
            <StatCard value={medianSec} label={L.medianDur} color="var(--c-cyan)" />
          </div>

          {/* trend + latest run — v2 */}
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}>
            <Card
              title={L.trendTitle}
              action={<RefChip id="FR-054" />}
            >
              {trend.length > 0 ? (
                <TrendBars data={trend} height={130} />
              ) : (
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{L.noRuns}</div>
              )}
            </Card>
            <Card title={L.latestRun}>
              {run ? (
                <div className="row" style={{ gap: 18, alignItems: "center" }}>
                  <Donut
                    passed={counts.passed ?? 0}
                    failed={counts.failed ?? 0}
                    errored={counts.errored ?? 0}
                  />
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <Badge tone={stateTone(run.state)}>{run.state}</Badge>
                      <Mono style={{ fontSize: 11, color: "var(--text-muted)" }}>{runLabel}</Mono>
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                      <span style={{ color: "var(--success)" }}>{counts.passed ?? 0} {L.passed}</span>
                      {" · "}
                      <span style={{ color: "var(--error)" }}>{counts.failed ?? 0} {L.failed}</span>
                      {" · "}
                      <span style={{ color: "var(--warning)" }}>{counts.errored ?? 0} {L.errored}</span>
                    </div>
                    <Link href={`${base}/runs/${run.id}`}>
                      <Button variant="secondary" size="sm">{L.openReport}</Button>
                    </Link>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{L.noRuns}</div>
              )}
            </Card>
          </div>

          {/* regression watch + coverage gaps — v2 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            <Card title={L.regTitle} action={<RefChip id="FR-062" />}>
              {regressions.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--success)" }}>{L.regEmpty}</div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {regressions.slice(0, 8).map((r) => (
                    <div
                      key={r.test_case_id}
                      className="row"
                      style={{
                        gap: 10,
                        padding: "8px 10px",
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        alignItems: "center",
                      }}
                    >
                      <SeverityBadge severity={r.severity} />
                      <span
                        dir="auto"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 12.5,
                        }}
                        title={r.title}
                      >
                        {r.title}
                      </span>
                      {(r.requirement_external_ids ?? []).slice(0, 2).map((x) => (
                        <Mono key={x} style={{ fontSize: 10.5, color: "var(--accent)" }}>{x}</Mono>
                      ))}
                      <Link href={`${base}/runs/${r.run_id}`}>
                        <Badge tone={r.outcome === "failed" ? "error" : "warning"}>{r.outcome}</Badge>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title={L.gapsTitle} action={<RefChip id="FR-051" />}>
              {gaps.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--success)" }}>{L.gapsEmpty}</div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {gaps.slice(0, 6).map((g) => (
                    <div
                      key={g.requirement_id}
                      style={{
                        padding: "10px 12px",
                        background: "var(--warning-subtle, rgba(255,197,61,.16))",
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                      }}
                    >
                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        <Mono style={{ fontSize: 11.5, color: "var(--warning)" }}>
                          {g.external_id || g.requirement_id.slice(0, 8)}
                        </Mono>
                        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          {L.gapReasons[g.reason ?? ""] ?? g.reason}
                        </span>
                        <span style={{ flex: 1 }} />
                        <Link href={`${base}/generate?req=${g.requirement_id}`}>
                          <Button variant="ghost" size="sm">{L.targetedGen}</Button>
                        </Link>
                      </div>
                      {g.next_action && (
                        <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
                          {g.next_action}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* case-state chips */}
          <Card title={L.caseStates}>
            <div className="row" style={{ gap: 10 }}>
              {TC_STATES.map((s) => (
                <span
                  key={s}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
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

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: 16,
            }}
          >
            {/* quick actions */}
            <Card title={L.quick}>
              <div className="row" style={{ gap: 8 }}>
                <Link href={`${base}/requirements`}>
                  <Button variant="secondary" size="sm">
                    {L.uploadDoc}
                  </Button>
                </Link>
                <Link href={`${base}/endpoints`}>
                  <Button variant="secondary" size="sm">
                    {L.importSpec}
                  </Button>
                </Link>
                <Link href={`${base}/generate`}>
                  <Button variant="secondary" size="sm">
                    {L.goGenerate}
                  </Button>
                </Link>
                <Link href={`${base}/review`}>
                  <Button variant="secondary" size="sm">
                    {L.goReview}
                  </Button>
                </Link>
                <Link href={`${base}/runs`}>
                  <Button variant="primary" size="sm">
                    {L.goRun}
                  </Button>
                </Link>
              </div>
            </Card>
          </div>

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
                    dir="ltr"
                    style={{
                      color: PIPELINE_COLORS[i],
                      background: "var(--bg)",
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
        </>
      )}
    </div>
  );
}
