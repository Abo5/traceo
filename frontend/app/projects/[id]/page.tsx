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
  Mono,
  PageHeader,
  StatCard,
  StatusDot,
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
    state: string;
    started_at?: string | null;
    finished_at?: string | null;
    counts?: Record<string, number>;
  } | null;
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
          {/* stat cards */}
          <div className="grid-stats">
            <StatCard value={dash.requirement_count} label={L.reqs} />
            <StatCard value={dash.confirmed_count} label={L.confirmed} color="var(--success)" />
            <StatCard value={totalCases} label={L.cases} color="var(--c-violet)" />
            <StatCard
              value={`${dash.coverage_pct}%`}
              label={L.coverage}
              color="var(--accent)"
            />
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
            {/* latest run */}
            <Card title={L.latestRun}>
              {run ? (
                <div className="stack" style={{ gap: 12 }}>
                  <div className="row">
                    <Badge tone={stateTone(run.state)}>{run.state}</Badge>
                    <Mono style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {run.id.slice(0, 8)}
                    </Mono>
                  </div>
                  <div className="row" style={{ gap: 14 }}>
                    <span style={{ fontSize: 12.5, color: "var(--success)" }}>
                      {L.passed} <Mono style={{ fontWeight: 700 }}>{counts.passed ?? 0}</Mono>
                    </span>
                    <span style={{ fontSize: 12.5, color: "var(--error)" }}>
                      {L.failed} <Mono style={{ fontWeight: 700 }}>{counts.failed ?? 0}</Mono>
                    </span>
                    <span style={{ fontSize: 12.5, color: "var(--warning)" }}>
                      {L.errored} <Mono style={{ fontWeight: 700 }}>{counts.errored ?? 0}</Mono>
                    </span>
                    <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                      {L.total} <Mono style={{ fontWeight: 700 }}>{counts.total ?? 0}</Mono>
                    </span>
                  </div>
                  <div>
                    <Link href={`${base}/runs/${run.id}`}>
                      <Button variant="secondary" size="sm">
                        {L.viewRun}
                      </Button>
                    </Link>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{L.noRuns}</div>
              )}
            </Card>

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
