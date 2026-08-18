"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Modal,
  PageHeader,
  RefChip,
  Select,
  Table,
} from "@/components/ui";

type Token = {
  id: string;
  name: string;
  project_id: string | null;
  role: string;
  prefix: string;
  revoked: boolean;
  last_used_at: string | null;
  created_at: string | null;
};

type Project = { id: string; name: string };

export default function TokensPage() {
  const { lang } = useLang();
  const ar = lang === "ar";

  const L = ar
    ? {
        title: "رموز الوصول",
        sub: "رموز غير تفاعلية لمشغّلات CI — يُعرض الرمز مرة واحدة فقط عند الإنشاء",
        members: "الأعضاء",
        audit: "سجل التدقيق",
        create: "رمز جديد",
        name: "الاسم",
        scope: "النطاق",
        role: "الدور",
        allProjects: "كل المشاريع",
        lastUsed: "آخر استخدام",
        created: "أُنشئ",
        never: "لم يُستخدم",
        revoke: "إبطال",
        revoked: "مُبطَل",
        active: "نشط",
        actions: "إجراءات",
        empty: "لا توجد رموز بعد",
        emptyHint: "أنشئ رمزاً ليتمكّن خط الأنابيب من تشغيل الاختبارات وقراءة حكم البوابة",
        cancel: "إلغاء",
        copyOnce: "انسخ هذا الرمز الآن — لن يُعرض مرة أخرى",
        copy: "نسخ",
        copied: "تم النسخ",
        done: "تم",
        loading: "جارٍ التحميل…",
      }
    : {
        title: "API tokens",
        sub: "Non-interactive tokens for CI runners — the value is shown once, at creation",
        members: "Members",
        audit: "Audit log",
        create: "New token",
        name: "Name",
        scope: "Scope",
        role: "Role",
        allProjects: "All projects",
        lastUsed: "Last used",
        created: "Created",
        never: "Never used",
        revoke: "Revoke",
        revoked: "Revoked",
        active: "Active",
        actions: "Actions",
        empty: "No tokens yet",
        emptyHint: "Create one so a pipeline can start runs and read the gate verdict",
        cancel: "Cancel",
        copyOnce: "Copy this token now — it will never be shown again",
        copy: "Copy",
        copied: "Copied",
        done: "Done",
        loading: "Loading…",
      };

  const [tokens, setTokens] = useState<Token[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ name: "", project_id: "", role: "qa_engineer" });
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, p] = await Promise.all([
        api<{ tokens: Token[] }>("/tokens"),
        api<any>("/projects"),
      ]);
      setTokens(t.tokens ?? []);
      setProjects(Array.isArray(p) ? p : p?.projects ?? []);
      setError(null);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy("create");
    setError(null);
    try {
      const res = await api<any>("/tokens", {
        body: {
          name: form.name,
          role: form.role,
          ...(form.project_id ? { project_id: form.project_id } : {}),
        },
      });
      setModal(false);
      setIssued(res.token);
      setCopied(false);
      setForm({ name: "", project_id: "", role: "qa_engineer" });
      await load();
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(token: Token) {
    setBusy(token.id);
    try {
      await api(`/tokens/${token.id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={
          <>
            {L.title} <RefChip id="FR-061" />
          </>
        }
        sub={L.sub}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Link href="/settings/members">
              <Button variant="ghost">{L.members}</Button>
            </Link>
            <Link href="/settings/audit">
              <Button variant="ghost">{L.audit}</Button>
            </Link>
            <Button onClick={() => setModal(true)}>{L.create}</Button>
          </div>
        }
      />

      {error && (
        <div className="card" style={{ borderColor: "var(--error)", marginBottom: 16 }}>
          <div className="card-body" style={{ color: "var(--error)" }}>{error}</div>
        </div>
      )}

      {loading ? (
        <div className="card">
          <div className="card-body">{L.loading}</div>
        </div>
      ) : tokens.length === 0 ? (
        <Empty icon="🔑" title={L.empty} hint={L.emptyHint} />
      ) : (
        <Table head={[L.name, L.scope, L.role, L.lastUsed, L.created, L.actions]}>
          {tokens.map((t) => (
            <tr key={t.id} style={{ opacity: t.revoked ? 0.55 : 1 }}>
              <td>
                <div>{t.name}</div>
                <span className="mono" dir="ltr" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {t.prefix}…
                </span>
              </td>
              <td>
                {t.project_id
                  ? projects.find((p) => p.id === t.project_id)?.name ?? t.project_id.slice(0, 8)
                  : L.allProjects}
              </td>
              <td>
                <Badge tone="info">{t.role}</Badge>
              </td>
              <td className="mono" style={{ fontSize: 11 }} dir="ltr">
                {t.last_used_at ? t.last_used_at.slice(0, 16).replace("T", " ") : L.never}
              </td>
              <td className="mono" style={{ fontSize: 11 }} dir="ltr">
                {t.created_at ? t.created_at.slice(0, 10) : "—"}
              </td>
              <td>
                {t.revoked ? (
                  <Badge tone="muted">{L.revoked}</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => revoke(t)} disabled={busy === t.id}>
                    {L.revoke}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={L.create}>
        <div style={{ display: "grid", gap: 12 }}>
          <Field label={L.name}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={L.scope}>
            <Select
              value={form.project_id}
              onChange={(e) => setForm({ ...form, project_id: e.target.value })}
            >
              <option value="">{L.allProjects}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={L.role}>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {["qa_engineer", "qa_lead", "viewer"].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setModal(false)}>{L.cancel}</Button>
            <Button onClick={create} disabled={!form.name || busy === "create"}>{L.create}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!issued} onClose={() => setIssued(null)} title={L.copyOnce}>
        <div style={{ display: "grid", gap: 12 }}>
          <pre
            className="mono"
            dir="ltr"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--accent)",
              borderRadius: 8,
              padding: "12px 14px",
              overflowX: "auto",
              margin: 0,
              textAlign: "left",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
            }}
          >
            {issued}
          </pre>
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <Button
              variant="ghost"
              onClick={() => {
                if (issued) navigator.clipboard?.writeText(issued);
                setCopied(true);
              }}
            >
              {copied ? L.copied : L.copy}
            </Button>
            <Button onClick={() => setIssued(null)}>{L.done}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
