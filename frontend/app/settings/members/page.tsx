"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getUser } from "@/lib/api";
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

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  qa_lead: "QA Lead",
  qa_engineer: "QA Engineer",
  viewer: "Viewer",
};

export default function MembersPage() {
  const canDo = useCan();

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
        title="Members"
        sub="Manage your organisation's members and roles"
        testId="members-page-header"
        actions={
          <>
            {canDo("view_audit_log") && (
              <Link href="/settings/audit">
                <Button variant="ghost" size="sm" testId="members-audit-link-button">
                  Audit log
                </Button>
              </Link>
            )}
            {canDo("manage_members") && (
              <Button variant="primary" testId="members-invite-button" onClick={() => setInviteOpen(true)}>
                + Invite member
              </Button>
            )}
          </>
        }
      />

      {error && <div className="error-text" data-testid="members-error-text">{error}</div>}

      {loading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</div>
      ) : members.length === 0 ? (
        <Empty title="No members" testId="members-empty-state" />
      ) : (
        <div className="card" style={{ padding: "6px 18px 12px" }}>
          <Table head={["Name", "Email", "Role", "Joined", "Actions"]} testId="members-table-root">
            {members.map((m) => (
              <tr key={m.id} data-testid="members-row">
                <td style={{ fontWeight: 600 }}>
                  {m.name}
                  {me?.id === m.id && (
                    <span style={{ marginLeft: 8 }}>
                      <Badge tone="accent">You</Badge>
                    </span>
                  )}
                </td>
                <td>
                  <Mono style={{ fontSize: 12 }} testId="members-row-email-text">{m.email}</Mono>
                </td>
                <td>
                  <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                    <Badge tone={ROLE_TONES[m.role] ?? "muted"} testId="members-row-role-badge">{ROLE_LABELS[m.role] ?? m.role}</Badge>
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
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                </td>
                <td>
                  <Mono style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    {m.created_at ? m.created_at.slice(0, 10) : "—"}
                  </Mono>
                </td>
                <td>
                  {canDo("manage_members") && me?.id !== m.id && (
                    <Button variant="danger" size="sm" testId="members-row-remove-button" onClick={() => setRemoving(m)}>
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {/* invite modal */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite member" testId="members-invite-modal">
        <form onSubmit={invite} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name" testId="members-invite-name-input">
            <Input
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label="Email" testId="members-invite-email-input">
            <Input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </Field>
          <Field label="Role" testId="members-invite-role-select">
            <Select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Temporary password" hint="At least 8 characters — share it with the member; they can change it later" testId="members-invite-password-input">
            <Input
              type="password"
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
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={inviting} testId="members-invite-submit-button">
              Invite member
            </Button>
          </div>
        </form>
      </Modal>

      {/* remove confirm */}
      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Remove member" testId="members-remove-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
              {removing?.name} — <Mono style={{ fontSize: 12 }}>{removing?.email}</Mono>
            </div>
            This member will lose access to the organisation. Continue?
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="members-remove-cancel-button" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={removeBusy} testId="members-remove-confirm-button" onClick={runRemove}>
              Confirm
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
