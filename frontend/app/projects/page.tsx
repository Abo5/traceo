"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { TEST_TYPES, type TestType } from "@/lib/test-types";
import { TestTypePicker } from "@/components/test-type-picker";
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
} from "@/components/ui";

type Project = {
  id: string;
  name: string;
  status: string;
  created_at?: string | null;
};

export default function ProjectsPage() {
  const router = useRouter();
  const canDo = useCan();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", url: "" });
  // A new project is for every kind of testing until its owner narrows it —
  // the same default the backend applies when the field is omitted.
  const [types, setTypes] = useState<TestType[]>([...TEST_TYPES]);
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

  function openCreate() {
    setCreateError(null);
    setTypes([...TEST_TYPES]);
    setForm({ name: "", url: "" });
    setCreateOpen(true);
  }

  function toggleType(type: TestType) {
    setTypes((current) =>
      current.includes(type)
        ? current.filter((t) => t !== type)
        : TEST_TYPES.filter((t) => t === type || current.includes(t)),
    );
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const p = await api<Project>("/projects", {
        body: { name: form.name.trim(), test_types: types },
      });
      setCreateOpen(false);
      const target = form.url.trim();
      setForm({ name: "", url: "" });
      setTypes([...TEST_TYPES]);
      // A URL was given, so go straight to the screen that runs it and let that
      // screen start the discovery. Starting it from here would be a second
      // place that launches a job — and the error handling, the progress bar
      // and the result card all already live there.
      router.push(
        target
          ? `/projects/${p.id}/target?url=${encodeURIComponent(target)}&start=1`
          : `/projects/${p.id}`,
      );
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
        <div className="grid-cards" data-testid="projects-list-grid">
          {projects.map((p) => (
            <div
              key={p.id}
              className="card"
              data-testid="projects-list-card"
              data-state={p.status}
              style={{
                padding: 18,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                opacity: p.status === "archived" ? 0.65 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <Link
                  href={`/projects/${p.id}`}
                  data-testid="projects-card-open-link"
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    letterSpacing: "-0.01em",
                    flex: 1,
                    minWidth: 0,
                    overflowWrap: "anywhere",
                  }}
                >
                  {p.name}
                </Link>
                {p.status === "archived" && (
                  <Badge tone="muted" testId="projects-card-status-badge" state={p.status}>
                    Archived
                  </Badge>
                )}
              </div>
              {p.created_at && (
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  Created <Mono style={{ fontSize: 11 }}>{p.created_at.slice(0, 10)}</Mono>
                </div>
              )}
              <div className="row" style={{ marginTop: "auto" }}>
                <Button variant="secondary" size="sm" testId="projects-card-open-button" onClick={() => router.push(`/projects/${p.id}`)}>
                  Open
                </Button>
                {canManage &&
                  (p.status === "archived" ? (
                    <Button variant="ghost" size="sm" testId="projects-card-unarchive-button" onClick={() => unarchive(p)}>
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
                  ))}
                {canManage && (
                  <Button
                    variant="danger"
                    size="sm"
                    testId="projects-card-delete-button"
                    onClick={() => setConfirming({ project: p, action: "delete" })}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
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
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "var(--text-secondary)",
                marginBottom: 4,
              }}
            >
              Test types
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
              What this project is for. You can change it later from Overview.
            </div>
            <TestTypePicker
              selected={types}
              onToggle={toggleType}
              testIdPrefix="projects-create-type"
            />
            {types.length === 0 && (
              <div
                data-testid="projects-create-types-hint"
                style={{ fontSize: 12, color: "var(--warning)", marginTop: 8 }}
              >
                Pick at least one — a project that tests nothing has nothing to do.
              </div>
            )}
          </div>
          <Field
            label="Page URL (optional)"
            hint="Give a URL and Traceo opens it in a browser and starts testing it right away. You can add one later instead."
            testId="projects-create-url-input"
          >
            <Input
              type="url"
              maxLength={1000}
              placeholder="https://example.com/login"
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            />
          </Field>
          {form.url.trim() !== "" && !/^https?:\/\/\S+$/i.test(form.url.trim()) && (
            <div
              data-testid="projects-create-url-hint"
              style={{ fontSize: 12, color: "var(--warning)" }}
            >
              Enter an absolute http:// or https:// URL, or leave it empty.
            </div>
          )}
          {createError && <div className="error-text" data-testid="projects-create-error-text">{createError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="projects-create-cancel-button" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" testId="projects-create-submit-button" disabled={
                creating ||
                !form.name.trim() ||
                types.length === 0 ||
                (form.url.trim() !== "" && !/^https?:\/\/\S+$/i.test(form.url.trim()))
              }
            >
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
