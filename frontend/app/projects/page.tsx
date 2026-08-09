"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { useCan } from "@/lib/permissions";
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
  language: string | null;
  status: string;
  created_at?: string | null;
};

export default function ProjectsPage() {
  const router = useRouter();
  const { lang } = useLang();
  const ar = lang === "ar";
  const canDo = useCan();

  const L = ar
    ? {
        title: "المشاريع",
        sub: "اختر مشروعًا أو أنشئ واحدًا جديدًا",
        newProject: "مشروع جديد",
        name: "اسم المشروع",
        arabic: "العربية",
        english: "الإنجليزية",
        create: "إنشاء",
        cancel: "إلغاء",
        empty: "لا توجد مشاريع بعد",
        emptyHint: "أنشئ مشروعك الأول للبدء",
        archived: "مؤرشف",
        archive: "أرشفة",
        unarchive: "إلغاء الأرشفة",
        del: "حذف",
        open: "فتح",
        confirmArchiveTitle: "أرشفة المشروع",
        confirmArchive: "سيُخفى المشروع من القوائم النشطة مع الاحتفاظ ببياناته. متابعة؟",
        confirmDeleteTitle: "حذف المشروع",
        confirmDelete:
          "سيُحذف المشروع وكل بياناته (المتطلبات، الحالات، التشغيلات) نهائيًا. هذا الإجراء لا يمكن التراجع عنه.",
        confirm: "تأكيد",
        createdAt: "أُنشئ في",
        loading: "جارٍ التحميل…",
      }
    : {
        title: "Projects",
        sub: "Pick a project or create a new one",
        newProject: "New project",
        name: "Project name",
        arabic: "Arabic",
        english: "English",
        create: "Create",
        cancel: "Cancel",
        empty: "No projects yet",
        emptyHint: "Create your first project to get started",
        archived: "Archived",
        archive: "Archive",
        unarchive: "Unarchive",
        del: "Delete",
        open: "Open",
        confirmArchiveTitle: "Archive project",
        confirmArchive:
          "The project will be hidden from active lists; data is retained. Continue?",
        confirmDeleteTitle: "Delete project",
        confirmDelete:
          "The project and ALL of its data (requirements, cases, runs) will be permanently deleted. This cannot be undone.",
        confirm: "Confirm",
        createdAt: "Created",
        loading: "Loading…",
      };

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="stack" data-testid="projects-page-root">
      <PageHeader
        title={L.title}
        sub={L.sub}
        testId="projects-page-header"
        actions={
          canDo("manage_projects") ? (
            <Button variant="primary" testId="projects-list-create-button" onClick={() => setCreateOpen(true)}>
              + {L.newProject}
            </Button>
          ) : undefined
        }
      />

      {error && <div className="error-text" data-testid="projects-page-error-text">{error}</div>}

      {loading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{L.loading}</div>
      ) : projects.length === 0 ? (
        <Empty title={L.empty} hint={L.emptyHint} testId="projects-empty-state" />
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
                {p.language && (
                  <Badge tone="accent" testId="projects-card-language-badge">{p.language === "ar" ? L.arabic : L.english}</Badge>
                )}
                {p.status === "archived" && (
                  <Badge tone="muted" testId="projects-card-status-badge" state={p.status}>{L.archived}</Badge>
                )}
              </div>
              {p.created_at && (
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  {L.createdAt} <Mono style={{ fontSize: 11 }}>{p.created_at.slice(0, 10)}</Mono>
                </div>
              )}
              <div className="row" style={{ marginTop: "auto" }}>
                <Button variant="secondary" size="sm" testId="projects-card-open-button" onClick={() => router.push(`/projects/${p.id}`)}>
                  {L.open}
                </Button>
                {canDo("manage_projects") &&
                  (p.status === "archived" ? (
                    <Button variant="ghost" size="sm" testId="projects-card-unarchive-button" onClick={() => unarchive(p)}>
                      {L.unarchive}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      testId="projects-card-archive-button"
                      onClick={() => setConfirming({ project: p, action: "archive" })}
                    >
                      {L.archive}
                    </Button>
                  ))}
                {canDo("manage_projects") && (
                  <Button
                    variant="danger"
                    size="sm"
                    testId="projects-card-delete-button"
                    onClick={() => setConfirming({ project: p, action: "delete" })}
                  >
                    {L.del}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* create modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={L.newProject} testId="projects-create-modal">
        <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.name} testId="projects-create-name-input">
            <Input
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          {createError && <div className="error-text" data-testid="projects-create-error-text">{createError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="projects-create-cancel-button" onClick={() => setCreateOpen(false)}>
              {L.cancel}
            </Button>
            <Button type="submit" variant="primary" testId="projects-create-submit-button" disabled={creating || !form.name.trim()}>
              {L.create}
            </Button>
          </div>
        </form>
      </Modal>

      {/* archive / delete confirm modal */}
      <Modal
        open={!!confirming}
        onClose={() => setConfirming(null)}
        title={confirming?.action === "delete" ? L.confirmDeleteTitle : L.confirmArchiveTitle}
        testId="projects-confirm-modal"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
              {confirming?.project.name}
            </div>
            {confirming?.action === "delete" ? L.confirmDelete : L.confirmArchive}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="projects-confirm-cancel-button" onClick={() => setConfirming(null)}>
              {L.cancel}
            </Button>
            <Button
              variant={confirming?.action === "delete" ? "danger" : "primary"}
              disabled={confirmBusy}
              testId="projects-confirm-submit-button"
              onClick={runConfirm}
            >
              {L.confirm}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
