"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getUser } from "@/lib/api";
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
  Select,
  Table,
} from "@/components/ui";

type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at?: string | null;
};

const ROLES = ["admin", "qa_lead", "qa_engineer", "viewer"] as const;

const ROLE_TONES: Record<string, "accent" | "info" | "success" | "muted"> = {
  admin: "accent",
  qa_lead: "info",
  qa_engineer: "success",
  viewer: "muted",
};

export default function MembersPage() {
  const { lang } = useLang();
  const ar = lang === "ar";
  const canDo = useCan();

  const L = ar
    ? {
        title: "الأعضاء",
        sub: "إدارة أعضاء المنشأة وأدوارهم",
        audit: "سجل التدقيق",
        invite: "دعوة عضو",
        name: "الاسم",
        email: "البريد الإلكتروني",
        role: "الدور",
        joined: "تاريخ الانضمام",
        actions: "إجراءات",
        remove: "إزالة",
        tempPassword: "كلمة مرور مؤقتة",
        tempHint: "8 أحرف على الأقل — شاركها مع العضو ليغيّرها لاحقًا",
        roles: {
          admin: "مدير",
          qa_lead: "قائد جودة",
          qa_engineer: "مهندس جودة",
          viewer: "مشاهد",
        } as Record<string, string>,
        cancel: "إلغاء",
        confirm: "تأكيد",
        confirmRemoveTitle: "إزالة عضو",
        confirmRemove: "سيفقد هذا العضو الوصول إلى المنشأة. متابعة؟",
        empty: "لا يوجد أعضاء",
        you: "أنت",
        loading: "جارٍ التحميل…",
      }
    : {
        title: "Members",
        sub: "Manage your organisation's members and roles",
        audit: "Audit log",
        invite: "Invite member",
        name: "Name",
        email: "Email",
        role: "Role",
        joined: "Joined",
        actions: "Actions",
        remove: "Remove",
        tempPassword: "Temporary password",
        tempHint: "At least 8 characters — share it with the member to change later",
        roles: {
          admin: "Admin",
          qa_lead: "QA Lead",
          qa_engineer: "QA Engineer",
          viewer: "Viewer",
        } as Record<string, string>,
        cancel: "Cancel",
        confirm: "Confirm",
        confirmRemoveTitle: "Remove member",
        confirmRemove: "This member will lose access to the organisation. Continue?",
        empty: "No members",
        you: "You",
        loading: "Loading…",
      };

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<any>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "qa_engineer", password: "" });
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [removing, setRemoving] = useState<Member | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [roleBusy, setRoleBusy] = useState<string | null>(null);

  async function load() {
    try {
      const list = await api<Member[]>("/members");
      setMembers(Array.isArray(list) ? list : (list as any)?.items ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setMe(getUser());
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    try {
      await api("/members/invite", {
        body: {
          name: form.name.trim(),
          email: form.email.trim(),
          role: form.role,
          password: form.password,
        },
      });
      setInviteOpen(false);
      setForm({ name: "", email: "", role: "qa_engineer", password: "" });
      await load();
    } catch (err: any) {
      setInviteError(err?.message || String(err));
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(m: Member, role: string) {
    if (role === m.role) return;
    setRoleBusy(m.id);
    try {
      await api(`/members/${m.id}`, { method: "PATCH", body: { role } });
      setMembers((prev) => prev.map((x) => (x.id === m.id ? { ...x, role } : x)));
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRoleBusy(null);
    }
  }

  async function runRemove() {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await api(`/members/${removing.id}`, { method: "DELETE" });
      setRemoving(null);
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
      setRemoving(null);
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <div className="stack" data-testid="members-page-root">
      <PageHeader
        title={L.title}
        sub={L.sub}
        testId="members-page-header"
        actions={
          <>
            {canDo("view_audit_log") && (
              <Link href="/settings/audit">
                <Button variant="ghost" size="sm" testId="members-audit-link-button">
                  {L.audit}
                </Button>
              </Link>
            )}
            {canDo("manage_members") && (
              <Button variant="primary" testId="members-invite-button" onClick={() => setInviteOpen(true)}>
                + {L.invite}
              </Button>
            )}
          </>
        }
      />

      {error && <div className="error-text" data-testid="members-error-text">{error}</div>}

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{L.loading}</div>
      ) : members.length === 0 ? (
        <Empty title={L.empty} testId="members-empty-state" />
      ) : (
        <div className="card" style={{ padding: "6px 18px 12px" }}>
          <Table head={[L.name, L.email, L.role, L.joined, L.actions]} testId="members-table-root">
            {members.map((m) => (
              <tr key={m.id} data-testid="members-row">
                <td style={{ fontWeight: 600 }}>
                  {m.name}
                  {me?.id === m.id && (
                    <span style={{ marginInlineStart: 8 }}>
                      <Badge tone="accent">{L.you}</Badge>
                    </span>
                  )}
                </td>
                <td>
                  <Mono style={{ fontSize: 12 }} testId="members-row-email-text">{m.email}</Mono>
                </td>
                <td>
                  <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                    <Badge tone={ROLE_TONES[m.role] ?? "muted"} testId="members-row-role-badge">{L.roles[m.role] ?? m.role}</Badge>
                    {canDo("manage_members") && (
                      <Select
                        value={m.role}
                        disabled={roleBusy === m.id}
                        style={{ width: 150 }}
                        testId="members-row-role-select"
                        onChange={(e) => changeRole(m, e.target.value)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {L.roles[r]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                </td>
                <td>
                  <Mono style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    {m.created_at ? m.created_at.slice(0, 10) : "—"}
                  </Mono>
                </td>
                <td>
                  {canDo("manage_members") && me?.id !== m.id && (
                    <Button variant="danger" size="sm" testId="members-row-remove-button" onClick={() => setRemoving(m)}>
                      {L.remove}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {/* invite modal */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title={L.invite} testId="members-invite-modal">
        <form onSubmit={invite} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.name} testId="members-invite-name-input">
            <Input
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label={L.email} testId="members-invite-email-input">
            <Input
              type="email"
              dir="ltr"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </Field>
          <Field label={L.role} testId="members-invite-role-select">
            <Select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {L.roles[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={L.tempPassword} hint={L.tempHint} testId="members-invite-password-input">
            <Input
              type="password"
              dir="ltr"
              required
              minLength={8}
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </Field>
          {inviteError && <div className="error-text" data-testid="members-invite-error-text">{inviteError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="members-invite-cancel-button" onClick={() => setInviteOpen(false)}>
              {L.cancel}
            </Button>
            <Button type="submit" variant="primary" disabled={inviting} testId="members-invite-submit-button">
              {L.invite}
            </Button>
          </div>
        </form>
      </Modal>

      {/* remove confirm */}
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={L.confirmRemoveTitle} testId="members-remove-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
              {removing?.name} — <Mono style={{ fontSize: 12 }}>{removing?.email}</Mono>
            </div>
            {L.confirmRemove}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="members-remove-cancel-button" onClick={() => setRemoving(null)}>
              {L.cancel}
            </Button>
            <Button variant="danger" disabled={removeBusy} testId="members-remove-confirm-button" onClick={runRemove}>
              {L.confirm}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
