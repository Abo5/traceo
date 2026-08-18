"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Badge, Button, Card, Empty, Mono, PageHeader } from "@/components/ui";

/**
 * Reports — the latest report from every project, in one list.
 *
 * The per-run report answers "what happened in run #1043". This answers the
 * question you have before you know which run to open: "which of my projects is
 * in trouble right now". It is workspace-scoped for that reason — a per-project
 * version would only restate the run history that the Runs page already shows.
 *
 * Every number here is read from `/projects/{id}/dashboard`, one call per
 * project, each tolerant of failure: a project whose dashboard errors still
 * appears in the list with its numbers blank, because dropping it silently
 * would be the one outcome you could not tell from "this project is fine".
 */

type Project = { id: string; name: string; status: string };

type Latest = {
  run_id: string | null;
  display_id: number | null;
  state: string | null;
  finished_at: string | null;
  passed: number;
  total: number;
  defects: number;
  coverage: number;
  loaded: boolean;
};

function relative(iso?: string | null): string {
  if (!iso) return "no runs yet";
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

/** The verdict word for a finished run, from its own pass rate. */
function verdict(l: Latest): { label: string; tone: "success" | "warning" | "error" | "muted" } {
  if (!l.loaded) return { label: "…", tone: "muted" };
  if (!l.run_id || !l.total) return { label: "No runs", tone: "muted" };
  const rate = (l.passed / l.total) * 100;
  if (rate === 100) return { label: "Passed", tone: "success" };
  if (rate >= 70) return { label: "Warnings", tone: "warning" };
  return { label: "Failed", tone: "error" };
}

export default function ReportsPage() {
  const L = {
    title: "Reports",
    sub: "The latest report from every project — open any to read it in full.",
    empty: "No projects yet",
    emptyHint: "Create a project and run it — its latest report will appear here.",
    open: "Open report",
    score: "pass rate",
    loadError: "Failed to load reports",
    retry: "Retry",
    loading: "Loading…",
    checks: "checks",
    bugs: "open",
    older: "Older reports live inside each project → Runs",
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const [latest, setLatest] = useState<Record<string, Latest>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<any>("/projects");
      setProjects(Array.isArray(res) ? res : res?.items ?? []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    let alive = true;
    if (projects.length === 0) return;
    (async () => {
      const entries = await Promise.all(
        projects.map(async (p) => {
          try {
            const d = await api<any>(`/projects/${p.id}/dashboard`);
            const c = d?.latest_run?.counts ?? {};
            const l: Latest = {
              run_id: d?.latest_run?.id ?? null,
              display_id: d?.latest_run?.display_id ?? null,
              state: d?.latest_run?.state ?? null,
              finished_at: d?.latest_run?.finished_at ?? d?.latest_run?.started_at ?? null,
              passed: Number(c.passed ?? 0),
              total: Number(c.total ?? 0),
              defects: Number(d?.open_defects?.total ?? 0),
              coverage: Number(d?.coverage_pct ?? 0),
              loaded: true,
            };
            return [p.id, l] as const;
          } catch {
            return null;
          }
        })
      );
      if (!alive) return;
      const next: Record<string, Latest> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      setLatest(next);
    })();
    return () => {
      alive = false;
    };
  }, [projects]);

  return (
    <div className="stack" data-testid="reports-page-root">
      <PageHeader title={L.title} sub={L.sub} testId="reports-page-header" />

      {error && (
        <Card testId="reports-error-card">
          <div className="stack" style={{ gap: 10, alignItems: "flex-start" }}>
            <div className="error-text" data-testid="reports-error-text">
              {L.loadError} — {error}
            </div>
            <Button variant="secondary" size="sm" testId="reports-retry-button" onClick={load}>
              {L.retry}
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{L.loading}</div>
      ) : projects.length === 0 ? (
        <Empty title={L.empty} hint={L.emptyHint} testId="reports-empty-state" />
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {projects.map((p) => {
              const l = latest[p.id] ?? {
                run_id: null, display_id: null, state: null, finished_at: null,
                passed: 0, total: 0, defects: 0, coverage: 0, loaded: false,
              };
              const v = verdict(l);
              return (
                <div
                  key={p.id}
                  className="card"
                  data-testid="reports-row"
                  data-state={p.status}
                  style={{
                    display: "flex", gap: 14, alignItems: "center",
                    padding: "14px 20px", flexWrap: "wrap",
                  }}
                >
                  <span className="sav" style={{ width: 34, height: 34, borderRadius: 9 }} aria-hidden>
                    {p.name.trim().charAt(0).toUpperCase()}
                  </span>

                  <div style={{ width: 210, minWidth: 160 }}>
                    <Link
                      href={`/projects/${p.id}`}
                      data-testid="reports-project-link"
                      style={{ fontSize: 13.5, fontWeight: 600, display: "block" }}
                    >
                      {p.name}
                    </Link>
                    <Mono style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                      {l.display_id ? `#${l.display_id} · ` : ""}
                      {relative(l.finished_at)}
                    </Mono>
                  </div>

                  <div title={l.loaded ? `${Math.round(l.coverage)}% requirement coverage` : undefined}>
                    {/* The score is the latest run's pass rate, so it agrees with
                        the verdict badge beside it. Coverage is a different
                        measure — a project can pass everything it runs while
                        covering little — and lives on the project's own pages. */}
                    <div style={{ fontSize: 20, fontWeight: 600 }}>
                      {l.loaded && l.total ? Math.round((l.passed / l.total) * 100) : "—"}
                    </div>
                    <div style={{ fontSize: 9.5, color: "var(--text-secondary)" }}>{L.score}</div>
                  </div>

                  <Badge tone={v.tone} testId="reports-verdict-badge" state={l.state ?? undefined}>
                    {v.label}
                  </Badge>

                  <span style={{ flex: 1, minWidth: 140, fontSize: 12, color: "var(--text-secondary)" }}>
                    {l.run_id
                      ? `${l.defects} ${L.bugs} · ${l.passed}/${l.total} ${L.checks}`
                      : ""}
                  </span>

                  {l.run_id ? (
                    <Link href={`/projects/${p.id}/runs/${l.run_id}`}>
                      <Button variant="secondary" size="sm" testId="reports-open-button">
                        {L.open}
                      </Button>
                    </Link>
                  ) : (
                    <Link href={`/projects/${p.id}/runs`}>
                      <Button variant="secondary" size="sm" testId="reports-run-button">
                        Run it
                      </Button>
                    </Link>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{L.older}</div>
        </>
      )}
    </div>
  );
}
