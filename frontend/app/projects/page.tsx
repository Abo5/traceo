"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Meter,
  Modal,
  Mono,
  PageHeader,
  Pill,
} from "@/components/ui";

type Project = {
  id: string;
  name: string;
  status: string;
  automation?: string;
  created_at?: string | null;
};

/** Per-project headline numbers, loaded card by card from /projects/{id}/dashboard. */
type Health = {
  coverage_pct: number;
  approved: number;
  total_cases: number;
  run_state?: string | null;
  run_label?: string | null;
  passed?: number;
  run_total?: number;
  defects?: number;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function matches(p: Project, f: FilterKey): boolean {
  if (f === "all") return true;
  if (f === "archived") return p.status === "archived";
  return p.status !== "archived";
}

function counted(list: Project[], f: FilterKey): number {
  return list.filter((p) => matches(p, f)).length;
}

export default function ProjectsPage() {
  const router = useRouter();
  const canDo = useCan();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [health, setHealth] = useState<Record<string, Health>>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<{
    project: Project;
    action: "archive" | "delete";
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  async function load() {
    try {
      const list = await api<Project[]>("/projects");
      setProjects(Array.isArray(list) ? list : (list as any)?.items ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The design's card carries a score and a coverage bar. Those live on
   * /projects/{id}/dashboard, one call per project — fired per card and
   * tolerant of failure, so a project whose dashboard errors still lists.
   */
  useEffect(() => {
    let alive = true;
    if (projects.length === 0) return;
    (async () => {
      const entries = await Promise.all(
        projects.map(async (p) => {
          try {
            const d = await api<any>(`/projects/${p.id}/dashboard`);
            const counts = d?.latest_run?.counts ?? {};
            const h: Health = {
              coverage_pct: Number(d?.coverage_pct ?? 0),
              approved: Number(d?.test_case_counts?.approved ?? 0),
              total_cases: Object.values(d?.test_case_counts ?? {}).reduce(
                (a: number, b: any) => a + (Number(b) || 0),
                0
              ),
              run_state: d?.latest_run?.state ?? null,
              run_label: d?.latest_run?.display_id
                ? `#${d.latest_run.display_id}`
                : d?.latest_run?.id
                  ? String(d.latest_run.id).slice(0, 8)
                  : null,
              passed: Number(counts.passed ?? 0),
              run_total: Number(counts.total ?? 0),
              defects: Number(d?.open_defects?.total ?? 0),
            };
            return [p.id, h] as const;
          } catch {
            return null;
          }
        })
      );
      if (!alive) return;
      const next: Record<string, Health> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      setHealth(next);
    })();
    return () => {
      alive = false;
    };
  }, [projects]);

  function openCreate() {
    setCreateError(null);
    setCreateOpen(true);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const p = await api<Project>("/projects", {
        body: { name: form.name.trim() },
      });
      setCreateOpen(false);
      setForm({ name: "" });
      router.push(`/projects/${p.id}`);
    } catch (err: any) {
      setCreateError(err?.message || String(err));
    } finally {
      setCreating(false);
    }
  }

  async function runConfirm() {
    if (!confirming) return;
    setConfirmBusy(true);
    try {
      if (confirming.action === "archive") {
        await api(`/projects/${confirming.project.id}`, {
          method: "PATCH",
          body: { status: "archived" },
        });
      } else {
        await api(`/projects/${confirming.project.id}`, { method: "DELETE" });
      }
      setConfirming(null);
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
      setConfirming(null);
    } finally {
      setConfirmBusy(false);
    }
  }

  async function unarchive(p: Project) {
    try {
      await api(`/projects/${p.id}`, { method: "PATCH", body: { status: "active" } });
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  const canManage = canDo("manage_projects");
  const visible = projects.filter((p) => matches(p, filter));

  return (
    <div className="stack" data-testid="projects-page-root">
      <PageHeader
        title="Projects"
        sub="Pick a project to continue, or create a new one to start the pipeline."
        testId="projects-page-header"
        actions={
          canManage ? (
            <Button variant="primary" testId="projects-list-create-button" onClick={openCreate}>
              + New Project
            </Button>
          ) : undefined
        }
      />

      {error && <div className="error-text" data-testid="projects-page-error-text">{error}</div>}

      {loading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</div>
      ) : projects.length === 0 ? (
        <Empty
          title="No projects yet"
          hint="A project holds your requirements, generated test cases and runs. Create one to get started — you only need a name."
          testId="projects-empty-state"
          action={
            canManage ? (
              <Button
                variant="primary"
                testId="projects-empty-create-button"
                onClick={openCreate}
              >
                + New Project
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="row" style={{ gap: 8 }} data-testid="projects-filter-row">
            {FILTERS.map((f) => (
              <Pill
                key={f.key}
                active={filter === f.key}
                onClick={() => setFilter(f.key)}
                testId={`projects-filter-${f.key}-pill`}
                state={f.key}
              >
                {f.label} · {counted(projects, f.key)}
              </Pill>
            ))}
          </div>

          <div className="grid-cards" data-testid="projects-list-grid">
            {visible.map((p) => {
              const h = health[p.id];
              const passRate =
                h && h.run_total ? Math.round(((h.passed ?? 0) / h.run_total) * 100) : null;
              return (
                <div
                  key={p.id}
                  className="card"
                  data-testid="projects-list-card"
                  data-state={p.status}
                  style={{
                    padding: "16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    
                  }}
                >
                  {/* identity row */}
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <span
                      className="sav"
                      style={{ width: 36, height: 36, fontSize: 15 }}
                      aria-hidden
                    >
                      {p.name.trim().charAt(0).toUpperCase()}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Link
                        href={`/projects/${p.id}`}
                        data-testid="projects-card-open-link"
                        style={{
                          fontSize: 14.5,
                          fontWeight: 600,
                          display: "block",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {p.name}
                      </Link>
                      <Mono style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                        {p.created_at ? `created ${p.created_at.slice(0, 10)}` : p.id.slice(0, 8)}
                        {p.automation ? ` · ${p.automation}` : ""}
                      </Mono>
                    </div>
                    {p.status === "archived" ? (
                      <Badge tone="muted" testId="projects-card-status-badge" state={p.status}>
                        Archived
                      </Badge>
                    ) : passRate === null ? (
                      <Badge tone="muted" testId="projects-card-status-badge" state={p.status}>
                        No runs
                      </Badge>
                    ) : (
                      <Badge
                        tone={passRate === 100 ? "success" : passRate >= 70 ? "warning" : "error"}
                        testId="projects-card-status-badge"
                        state={p.status}
                      >
                        {passRate === 100 ? "Passing" : passRate >= 70 ? "Warnings" : "Failing"}
                      </Badge>
                    )}
                  </div>

                  {/* score + coverage */}
                  <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 600 }}>
                        {h ? `${Math.round(h.coverage_pct)}` : "—"}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                        coverage score
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Meter
                        label="Coverage"
                        value={h ? `${Math.round(h.coverage_pct)}%` : "—"}
                        pct={h?.coverage_pct ?? 0}
                      />
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      fontSize: 10.5,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {h
                      ? `${h.run_label ? `Last run ${h.run_label}` : "No runs yet"} · ${h.approved} approved · ${h.defects ?? 0} open`
                      : "Loading…"}
                    <Link
                      href={`/projects/${p.id}`}
                      className="link"
                      style={{ marginInlineStart: "auto", fontSize: 11.5 }}
                      data-testid="projects-card-open-button"
                    >
                      Open →
                    </Link>
                  </div>

                  {canManage && (
                    <>
                      <div className="hr" />
                      <div className="row" style={{ gap: 8 }}>
                        {p.status === "archived" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            testId="projects-card-unarchive-button"
                            onClick={() => unarchive(p)}
                          >
                            Unarchive
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            testId="projects-card-archive-button"
                            onClick={() => setConfirming({ project: p, action: "archive" })}
                          >
                            Archive
                          </Button>
                        )}
                        <span style={{ flex: 1 }} />
                        <Button
                          variant="danger"
                          size="sm"
                          testId="projects-card-delete-button"
                          onClick={() => setConfirming({ project: p, action: "delete" })}
                        >
                          Delete
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* create modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New Project" testId="projects-create-modal">
        <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field
            label="Project name"
            hint="You can upload a requirements document right after this."
            testId="projects-create-name-input"
          >
            <Input
              required
              autoFocus
              maxLength={200}
              placeholder="e.g. Payments API"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          {createError && <div className="error-text" data-testid="projects-create-error-text">{createError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="projects-create-cancel-button" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" testId="projects-create-submit-button" disabled={creating || !form.name.trim()}>
              {creating ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* archive / delete confirm modal */}
      <Modal
        open={!!confirming}
        onClose={() => setConfirming(null)}
        title={confirming?.action === "delete" ? "Delete project" : "Archive project"}
        testId="projects-confirm-modal"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
              {confirming?.project.name}
            </div>
            {confirming?.action === "delete"
              ? "The project and ALL of its data (requirements, test cases, runs) will be permanently deleted. This cannot be undone."
              : "The project will be hidden from active lists; its data is retained. Continue?"}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="projects-confirm-cancel-button" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant={confirming?.action === "delete" ? "danger" : "primary"}
              disabled={confirmBusy}
              testId="projects-confirm-submit-button"
              onClick={runConfirm}
            >
              Confirm
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
