"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  Empty,
  Meter,
  Mono,
  PageHeader,
  StatCard,
} from "@/components/ui";
import { useProject } from "@/lib/project-context";

/**
 * Reports for one project — every run this project has produced, newest first.
 *
 * The workspace-level /reports answers "which of my projects is in trouble".
 * This one is the view you want once you are inside a project: how did each run
 * turn out, and which one should I open. It reads as a verdict list rather than
 * an execution log — the Runs page already shows the mechanics (state,
 * initiator, timings); this shows the outcome.
 */

type Run = {
  id: string;
  display_id?: number;
  state: string;
  started_at?: string | null;
  finished_at?: string | null;
  counts?: Record<string, number>;
};

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.runs ?? [];
}

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

function rateOf(r: Run): number | null {
  const c = r.counts ?? {};
  const total = Number(c.total ?? 0);
  if (!total) return null;
  return Math.round((Number(c.passed ?? 0) / total) * 100);
}

function needFixing(r: Run): number {
  const c = r.counts ?? {};
  return Number(c.failed ?? 0) + Number(c.errored ?? 0);
}

/** The verdict word for a run, from its own pass rate — not from run.state. */
function verdict(r: Run): { label: string; tone: "success" | "warning" | "error" | "muted" } {
  if (r.state === "aborted" || r.state === "cancelled") {
    return { label: r.state, tone: "muted" };
  }
  const rate = rateOf(r);
  if (rate === null) return { label: "No checks", tone: "muted" };
  if (rate === 100) return { label: "Passed", tone: "success" };
  if (rate >= 70) return { label: "Warnings", tone: "warning" };
  return { label: "Failed", tone: "error" };
}

export default function ProjectReportsPage() {
  const { id } = useParams<{ id: string }>();
  const { project } = useProject();

  const L = {
    title: "Reports",
    sub: "Every run this project has produced — open one to read what it found.",
    empty: "No reports yet",
    emptyHint: "A report is what a run leaves behind. Start one and it will appear here.",
    startRun: "Start a run",
    open: "Open report",
    score: "pass rate",
    checks: "checks",
    fixing: "need fixing",
    latest: "Latest",
    reports: "Reports",
    bestRate: "Best pass rate",
    openNow: "Open now",
    loadError: "Failed to load reports",
    retry: "Retry",
    loading: "Loading…",
  };

  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<any>(`/projects/${id}/runs`);
      setRuns(asList(res));
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

  const latest = runs[0] ?? null;
  const rates = runs.map(rateOf).filter((r): r is number => r !== null);
  const best = rates.length ? Math.max(...rates) : null;
  const openNow = latest ? needFixing(latest) : 0;

  return (
    <div className="stack" data-testid="project-reports-page-root">
      <PageHeader
        title={project?.name ? `${project.name} — ${L.title}` : L.title}
        sub={L.sub}
        testId="project-reports-page-header"
        actions={
          <Link href={`/projects/${id}/runs`}>
            <Button variant="primary" size="sm" testId="project-reports-new-run-button">
              ▶ {L.startRun}
            </Button>
          </Link>
        }
      />

      {error && (
        <Card testId="project-reports-error-card">
          <div className="stack" style={{ gap: 10, alignItems: "flex-start" }}>
            <div className="error-text" data-testid="project-reports-error-text">
              {L.loadError} — {error}
            </div>
            <Button variant="secondary" size="sm" testId="project-reports-retry-button" onClick={load}>
              {L.retry}
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{L.loading}</div>
      ) : runs.length === 0 ? (
        <Empty
          title={L.empty}
          hint={L.emptyHint}
          testId="project-reports-empty-state"
          action={
            <Link href={`/projects/${id}/runs`}>
              <Button variant="primary" testId="project-reports-empty-run-button">
                {L.startRun}
              </Button>
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid-stats">
            <StatCard
              value={runs.length}
              label={L.reports}
              hint="in this project"
              testId="project-reports-total-stat"
            />
            <StatCard
              value={latest && rateOf(latest) !== null ? `${rateOf(latest)}%` : "—"}
              label={L.latest}
              bar={latest ? rateOf(latest) ?? 0 : 0}
              testId="project-reports-latest-stat"
            />
            <StatCard
              value={best !== null ? `${best}%` : "—"}
              label={L.bestRate}
              hint="across all runs"
              testId="project-reports-best-stat"
            />
            <StatCard
              value={openNow}
              label={L.openNow}
              color={openNow > 0 ? "var(--error-text)" : undefined}
              hint={L.fixing}
              testId="project-reports-open-stat"
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {runs.map((r) => {
              const v = verdict(r);
              const rate = rateOf(r);
              const c = r.counts ?? {};
              const fixing = needFixing(r);
              return (
                <div
                  key={r.id}
                  className="card"
                  data-testid="project-reports-row"
                  data-state={r.state}
                  style={{
                    display: "flex",
                    gap: 14,
                    alignItems: "center",
                    padding: "14px 20px",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ width: 150, minWidth: 120 }}>
                    <Mono style={{ fontSize: 13.5, fontWeight: 700, display: "block" }}>
                      {r.display_id ? `#${r.display_id}` : r.id.slice(0, 8)}
                    </Mono>
                    <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                      {relative(r.finished_at ?? r.started_at)}
                    </span>
                  </div>

                  <div>
                    <div style={{ fontSize: 20, fontWeight: 600 }}>
                      {rate === null ? "—" : rate}
                    </div>
                    <div style={{ fontSize: 9.5, color: "var(--text-secondary)" }}>{L.score}</div>
                  </div>

                  <Badge tone={v.tone} testId="project-reports-verdict-badge" state={r.state}>
                    {v.label}
                  </Badge>

                  <div style={{ flex: 1, minWidth: 180 }}>
                    <Meter
                      label={`${c.passed ?? 0}/${c.total ?? 0} ${L.checks}`}
                      value={fixing > 0 ? `${fixing} ${L.fixing}` : "all passing"}
                      pct={rate ?? 0}
                    />
                  </div>

                  <Link href={`/projects/${id}/runs/${r.id}`}>
                    <Button variant="secondary" size="sm" testId="project-reports-open-button">
                      {L.open}
                    </Button>
                  </Link>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
