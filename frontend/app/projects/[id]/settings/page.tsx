"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useParams } from "next/navigation";
import { API, api, getToken } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { useProject } from "@/lib/project-context";
import {
  Badge,
  Button,
  Card,
  DateTimeText,
  Empty,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Pill,
  RefChip,
  Select,
  Table,
} from "@/components/ui";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  created_at?: string | null;
  last_used_at?: string | null;
  revoked: boolean;
};

type Schedule = {
  id: string;
  name: string;
  environment_id: string;
  interval_minutes: number;
  enabled: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
};

type Env = { id: string; name: string; base_url?: string };

const INTERVALS = [15, 30, 60, 360, 1440];

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? [];
}

async function downloadFile(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(API + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Inline toggle (36×20 track per spec §2.21) — ui.tsx has no Toggle. */
function Toggle({ on, onChange, disabled, testId, ariaLabel }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string; ariaLabel?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        border: `1px solid ${on ? "transparent" : "var(--border)"}`,
        background: on ? "var(--accent-fill)" : "var(--surface-3)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1.5,
          left: on ? 17 : 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          background: "#F2EFF7",
          transition: "left 120ms ease-out",
        }}
      />
    </button>
  );
}

function CopyButton({ text, label, copied: copiedLabel }: { text: string; label: string; copied: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? copiedLabel : label}
    </Button>
  );
}

export default function SettingsPage() {
  const { id } = useParams<{ id: string }>();
  const canDo = useCan();
  const { project, refresh } = useProject();

  const L = {
    title: "Settings",
    sub: "Access keys, scheduling and data export",
    tabKeys: "API keys",
    tabSchedules: "Schedules",
    tabExport: "Data export",
    loading: "Loading…",
    retry: "Retry",
    loadError: "Failed to load",
    generalTitle: "General",
    automation: "Automation mode",
    automationHint:
      "Auto: confirm requirements and generate cases after parsing — approval and runs stay manual",
    autoMode: "Auto",
    manualMode: "Manual",
    keysTitle: "API keys",
    keysSub: "Keys for programmatic access and the CI/CD gate — sent as X-API-Key header",
    newKey: "New key",
    keyName: "Key name",
    keyPrefix: "Prefix",
    created: "Created",
    lastUsed: "Last used",
    state: "State",
    active: "Active",
    revoked: "Revoked",
    revoke: "Revoke",
    revokeTitle: "Revoke key",
    revokeConfirm: "This key will stop working immediately and cannot be restored. Continue?",
    confirm: "Confirm",
    cancel: "Cancel",
    create: "Create",
    creating: "Creating…",
    keyCreated: "Key created",
    keyOnceWarning: "The key will not be shown again — copy it now and store it somewhere safe",
    copy: "Copy",
    copied: "Copied ✓",
    done: "Done",
    keysEmpty: "No keys yet",
    keysEmptyHint: "Create a key for CI/CD or programmatic access",
    schedTitle: "Schedules",
    schedSub: "Automatic recurring runs of approved cases",
    newSched: "New schedule",
    editSched: "Edit schedule",
    schedName: "Schedule name",
    env: "Environment",
    pickEnv: "Pick an environment…",
    interval: "Interval",
    intervalLabels: {
      15: "Every 15 minutes",
      30: "Every 30 minutes",
      60: "Every hour",
      360: "Every 6 hours",
      1440: "Daily",
    } as Record<number, string>,
    enabled: "Enabled",
    disabled: "Disabled",
    lastRun: "Last run",
    nextRun: "Next run",
    actions: "Actions",
    edit: "Edit",
    del: "Delete",
    delSchedTitle: "Delete schedule",
    delSchedConfirm: "This schedule will be permanently deleted. Continue?",
    save: "Save",
    schedEmpty: "No schedules yet",
    schedEmptyHint: "Create a schedule to run approved cases automatically against an environment",
    noEnvs: "No environments — create one on the Environments page first",
    exportTitle: "Data export",
    exportSub: "Full export of your organisation data",
    pdplNote:
      "In line with the Personal Data Protection Law (PDPL), you can export a full copy of your organisation data: projects, requirements, test cases and run summaries — as JSON. Stored secrets and execution evidence are excluded.",
    exportBtn: "Download data copy (JSON)",
    exporting: "Exporting…",
    exportError: "Export failed",
  };

  const [tab, setTab] = useState<"keys" | "schedules" | "export">("keys");

  // ---- API keys state ----
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyFormError, setKeyFormError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  // ---- Schedules state ----
  const [scheds, setScheds] = useState<Schedule[]>([]);
  const [envs, setEnvs] = useState<Env[]>([]);
  const [schedLoading, setSchedLoading] = useState(true);
  const [schedError, setSchedError] = useState<string | null>(null);
  const [schedModalOpen, setSchedModalOpen] = useState(false);
  const [schedEditing, setSchedEditing] = useState<Schedule | null>(null);
  const [schedForm, setSchedForm] = useState({ name: "", environment_id: "", interval_minutes: 60, enabled: true });
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedFormError, setSchedFormError] = useState<string | null>(null);
  const [schedDeleting, setSchedDeleting] = useState<Schedule | null>(null);
  const [schedDeleteBusy, setSchedDeleteBusy] = useState(false);

  // ---- Export state ----
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // ---- General (automation) state ----
  const [generalBusy, setGeneralBusy] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  async function patchProject(body: { automation?: string }) {
    setGeneralBusy(true);
    setGeneralError(null);
    try {
      await api(`/projects/${id}`, { method: "PATCH", body });
      await refresh();
    } catch (e: any) {
      setGeneralError(e?.message || String(e));
    } finally {
      setGeneralBusy(false);
    }
  }

  function loadKeys() {
    setKeysLoading(true);
    setKeysError(null);
    api<ApiKey[]>(`/api-keys`)
      .then((r) => setKeys(asList(r)))
      .catch((e) => setKeysError(e?.message || String(e)))
      .finally(() => setKeysLoading(false));
  }

  function loadScheds() {
    setSchedLoading(true);
    setSchedError(null);
    Promise.all([api(`/projects/${id}/schedules`), api(`/projects/${id}/environments`)])
      .then(([s, e]) => {
        setScheds(asList(s));
        setEnvs(asList(e));
      })
      .catch((e) => setSchedError(e?.message || String(e)))
      .finally(() => setSchedLoading(false));
  }

  useEffect(() => {
    loadKeys();
    loadScheds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setKeyBusy(true);
    setKeyFormError(null);
    try {
      const res = await api<{ id: string; name: string; prefix: string; key: string }>(`/api-keys`, {
        body: { name: keyName.trim() },
      });
      setCreatedKey({ name: res.name, key: res.key });
      setKeyName("");
      loadKeys();
    } catch (err: any) {
      setKeyFormError(err?.message || String(err));
    } finally {
      setKeyBusy(false);
    }
  }

  async function revokeKey() {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await api(`/api-keys/${revoking.id}/revoke`, { method: "POST", body: {} });
      setRevoking(null);
      loadKeys();
    } catch (e: any) {
      setKeysError(e?.message || String(e));
      setRevoking(null);
    } finally {
      setRevokeBusy(false);
    }
  }

  function openSchedCreate() {
    setSchedEditing(null);
    setSchedForm({ name: "", environment_id: envs[0]?.id ?? "", interval_minutes: 60, enabled: true });
    setSchedFormError(null);
    setSchedModalOpen(true);
  }

  function openSchedEdit(s: Schedule) {
    setSchedEditing(s);
    setSchedForm({
      name: s.name,
      environment_id: s.environment_id,
      interval_minutes: s.interval_minutes,
      enabled: s.enabled,
    });
    setSchedFormError(null);
    setSchedModalOpen(true);
  }

  async function saveSched(e: React.FormEvent) {
    e.preventDefault();
    setSchedBusy(true);
    setSchedFormError(null);
    const body = {
      name: schedForm.name.trim(),
      environment_id: schedForm.environment_id,
      interval_minutes: Number(schedForm.interval_minutes),
      enabled: schedForm.enabled,
    };
    try {
      if (schedEditing) {
        await api(`/schedules/${schedEditing.id}`, { method: "PATCH", body });
      } else {
        await api(`/projects/${id}/schedules`, { body });
      }
      setSchedModalOpen(false);
      loadScheds();
    } catch (err: any) {
      setSchedFormError(err?.message || String(err));
    } finally {
      setSchedBusy(false);
    }
  }

  async function toggleSched(s: Schedule, enabled: boolean) {
    setScheds((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
    try {
      await api(`/schedules/${s.id}`, { method: "PATCH", body: { enabled } });
      loadScheds();
    } catch (e: any) {
      setSchedError(e?.message || String(e));
      loadScheds();
    }
  }

  async function deleteSched() {
    if (!schedDeleting) return;
    setSchedDeleteBusy(true);
    try {
      await api(`/schedules/${schedDeleting.id}`, { method: "DELETE" });
      setSchedDeleting(null);
      loadScheds();
    } catch (e: any) {
      setSchedError(e?.message || String(e));
      setSchedDeleting(null);
    } finally {
      setSchedDeleteBusy(false);
    }
  }

  async function runExport() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadFile(`/export/organisation`, "traceo_export.json");
    } catch (e: any) {
      setExportError(`${L.exportError} — ${e?.message || String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  const envName = (envId: string) => envs.find((e) => e.id === envId)?.name ?? "—";

  const loadingBox = (
    <div style={{ padding: 24, color: "var(--text-secondary)", fontSize: 13 }}>{L.loading}</div>
  );

  const errorBox = (msg: string, retry: () => void) => (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 16 }}>
      <div className="error-text" style={{ fontSize: 13 }}>
        {L.loadError} — {msg}
      </div>
      <Button variant="secondary" size="sm" onClick={retry}>
        {L.retry}
      </Button>
    </div>
  );

  return (
    <div className="stack" data-testid="settings-page-root">
      <PageHeader title={L.title} sub={L.sub} testId="settings-page-header" />

      {/* ---------- General: automation mode ---------- */}
      <Card title={L.generalTitle}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{L.automation}</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.6 }}>
                {L.automationHint}
              </div>
            </div>
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
              <Toggle
                on={(project?.automation ?? "auto") !== "manual"}
                disabled={generalBusy || !canDo("manage_projects")}
                onChange={(v) => patchProject({ automation: v ? "auto" : "manual" })}
                testId="settings-automation-toggle"
                ariaLabel={L.automation}
              />
              <span
                style={{
                  fontSize: 12,
                  color:
                    (project?.automation ?? "auto") !== "manual" ? "var(--success)" : "var(--text-secondary)",
                }}
              >
                {(project?.automation ?? "auto") !== "manual" ? L.autoMode : L.manualMode}
              </span>
            </span>
          </div>
          {generalError && <div className="error-text" style={{ fontSize: 13 }}>{generalError}</div>}
        </div>
      </Card>

      <div className="row" style={{ gap: 6 }}>
        <Pill active={tab === "keys"} testId="settings-tab-keys-pill" onClick={() => setTab("keys")}>
          {L.tabKeys}
        </Pill>
        <Pill active={tab === "schedules"} testId="settings-tab-schedules-pill" onClick={() => setTab("schedules")}>
          {L.tabSchedules}
        </Pill>
        <Pill active={tab === "export"} testId="settings-tab-export-pill" onClick={() => setTab("export")}>
          {L.tabExport}
        </Pill>
      </div>

      {/* ---------- API keys ---------- */}
      {tab === "keys" && (
        <Card
          title={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {L.keysTitle} <RefChip id="FR-061" />
            </span>
          }
          action={
            canDo("manage_projects") ? (
              <Button variant="primary" size="sm" testId="settings-keys-new-button" onClick={() => { setKeyFormError(null); setCreatedKey(null); setKeyModalOpen(true); }}>
                + {L.newKey}
              </Button>
            ) : undefined
          }
          pad={false}
        >
          <div style={{ padding: "8px 16px 0", fontSize: 12, color: "var(--text-secondary)" }}>{L.keysSub}</div>
          {keysLoading ? (
            loadingBox
          ) : keysError ? (
            errorBox(keysError, loadKeys)
          ) : keys.length === 0 ? (
            <Empty title={L.keysEmpty} hint={L.keysEmptyHint} testId="settings-keys-empty-state" />
          ) : (
            <Table head={[L.keyName, L.keyPrefix, L.created, L.lastUsed, L.state, L.actions]} testId="settings-keys-table">
              {keys.map((k) => (
                <tr key={k.id} data-testid="settings-keys-row" style={k.revoked ? { opacity: 0.55 } : undefined}>
                  <td style={{ fontSize: 13, color: "var(--text)" }}>{k.name}</td>
                  <td>
                    <Mono style={{ fontSize: 12, color: "var(--text-secondary)" }}>{k.prefix}…</Mono>
                  </td>
                  <td>
                    <DateTimeText value={k.created_at} style={{ color: "var(--text-secondary)" }} />
                  </td>
                  <td>
                    <DateTimeText value={k.last_used_at} style={{ color: "var(--text-secondary)" }} />
                  </td>
                  <td>
                    <Badge tone={k.revoked ? "muted" : "success"} testId="settings-keys-row-state-badge">{k.revoked ? L.revoked : L.active}</Badge>
                  </td>
                  <td>
                    {canDo("manage_projects") && !k.revoked && (
                      <Button variant="danger" size="sm" testId="settings-keys-revoke-button" onClick={() => setRevoking(k)}>
                        {L.revoke}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {/* ---------- Schedules ---------- */}
      {tab === "schedules" && (
        <Card
          title={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {L.schedTitle} <RefChip id="FR-060" />
            </span>
          }
          action={
            canDo("manage_projects") ? (
              <Button variant="primary" size="sm" testId="settings-schedules-new-button" onClick={openSchedCreate} disabled={envs.length === 0}>
                + {L.newSched}
              </Button>
            ) : undefined
          }
          pad={false}
        >
          <div style={{ padding: "8px 16px 0", fontSize: 12, color: "var(--text-secondary)" }}>{L.schedSub}</div>
          {schedLoading ? (
            loadingBox
          ) : schedError ? (
            errorBox(schedError, loadScheds)
          ) : scheds.length === 0 ? (
            <Empty title={L.schedEmpty} hint={envs.length === 0 ? L.noEnvs : L.schedEmptyHint} testId="settings-schedules-empty-state" />
          ) : (
            <Table head={[L.schedName, L.env, L.interval, L.state, L.lastRun, L.nextRun, L.actions]} testId="settings-schedules-table">
              {scheds.map((s) => (
                <tr key={s.id} data-testid="settings-schedules-row">
                  <td style={{ fontSize: 13, color: "var(--text)" }}>{s.name}</td>
                  <td style={{ fontSize: 13, color: "var(--text-secondary)" }}>{envName(s.environment_id)}</td>
                  <td style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    {L.intervalLabels[s.interval_minutes] ?? (
                      <Mono style={{ fontSize: 12 }}>{s.interval_minutes}m</Mono>
                    )}
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      {canDo("manage_projects") && (
                        <Toggle on={s.enabled} onChange={(v) => toggleSched(s, v)} testId="settings-schedule-enabled-toggle" ariaLabel={L.enabled} />
                      )}
                      <span style={{ fontSize: 12, color: s.enabled ? "var(--success)" : "var(--text-secondary)" }}>
                        {s.enabled ? L.enabled : L.disabled}
                      </span>
                    </span>
                  </td>
                  <td>
                    <DateTimeText value={s.last_run_at} style={{ color: "var(--text-secondary)" }} />
                  </td>
                  <td>
                    <DateTimeText value={s.next_run_at} style={{ color: "var(--text-secondary)" }} />
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      {canDo("manage_projects") && (
                        <Button variant="ghost" size="sm" testId="settings-schedule-edit-button" onClick={() => openSchedEdit(s)}>
                          {L.edit}
                        </Button>
                      )}
                      {canDo("manage_projects") && (
                        <Button variant="danger" size="sm" testId="settings-schedule-delete-button" onClick={() => setSchedDeleting(s)}>
                          {L.del}
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {/* ---------- Export ---------- */}
      {tab === "export" && (
        <Card
          title={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {L.exportTitle} <RefChip id="FR-082" />
            </span>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }}>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>{L.exportSub}</div>
            <div
              style={{
                background: "var(--accent-subtle)",
                borderRadius: 10,
                padding: 14,
                fontSize: 12.5,
                lineHeight: 1.7,
                color: "var(--text-secondary)",
              }}
            >
              {L.pdplNote}
            </div>
            {exportError && <div className="error-text" style={{ fontSize: 13 }}>{exportError}</div>}
            <div>
              {canDo("manage_members") && (
                <Button variant="primary" testId="settings-export-button" disabled={exporting} onClick={runExport}>
                  {exporting ? L.exporting : `⇩ ${L.exportBtn}`}
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* ---------- Create key modal ---------- */}
      <Modal
        open={keyModalOpen}
        onClose={() => {
          setKeyModalOpen(false);
          setCreatedKey(null);
        }}
        title={createdKey ? L.keyCreated : L.newKey}
        testId="settings-key-modal"
      >
        {createdKey ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{createdKey.name}</div>
            <div
              className="code-block"
              data-testid="settings-key-value"
              style={{ overflowWrap: "anywhere", display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}
            >
              <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{createdKey.key}</span>
              <CopyButton text={createdKey.key} label={L.copy} copied={L.copied} />
            </div>
            <div
              style={{
                background: "var(--warning-subtle)",
                borderRadius: 10,
                padding: "10px 14px",
                fontSize: 12.5,
                color: "var(--warning)",
              }}
            >
              ⚠ {L.keyOnceWarning}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="primary"
                testId="settings-key-done-button"
                onClick={() => {
                  setKeyModalOpen(false);
                  setCreatedKey(null);
                }}
              >
                {L.done}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={createKey} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Field label={L.keyName}>
              <Input
                required
                maxLength={100}
                testId="settings-key-name-input"
                placeholder="e.g. CI Pipeline"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </Field>
            {keyFormError && <div className="error-text" style={{ fontSize: 13 }}>{keyFormError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="ghost" testId="settings-key-cancel-button" onClick={() => setKeyModalOpen(false)}>
                {L.cancel}
              </Button>
              <Button type="submit" variant="primary" testId="settings-key-submit-button" disabled={keyBusy || !keyName.trim()}>
                {keyBusy ? L.creating : L.create}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- Revoke confirm ---------- */}
      <Modal open={!!revoking} onClose={() => setRevoking(null)} title={L.revokeTitle} testId="settings-revoke-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
              {revoking?.name} — <Mono style={{ fontSize: 12 }}>{revoking?.prefix}…</Mono>
            </div>
            {L.revokeConfirm}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="settings-revoke-cancel-button" onClick={() => setRevoking(null)}>
              {L.cancel}
            </Button>
            <Button variant="danger" testId="settings-revoke-confirm-button" disabled={revokeBusy} onClick={revokeKey}>
              {L.confirm}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---------- Schedule modal ---------- */}
      <Modal open={schedModalOpen} onClose={() => setSchedModalOpen(false)} title={schedEditing ? L.editSched : L.newSched} testId="settings-schedule-modal">
        <form onSubmit={saveSched} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.schedName}>
            <Input
              required
              maxLength={100}
              testId="settings-schedule-name-input"
              placeholder="e.g. Nightly run"
              value={schedForm.name}
              onChange={(e) => setSchedForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label={L.env}>
            <Select
              required
              testId="settings-schedule-env-select"
              value={schedForm.environment_id}
              onChange={(e) => setSchedForm((f) => ({ ...f, environment_id: e.target.value }))}
            >
              <option value="">{L.pickEnv}</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={L.interval}>
            <Select
              testId="settings-schedule-interval-select"
              value={String(schedForm.interval_minutes)}
              onChange={(e) => setSchedForm((f) => ({ ...f, interval_minutes: Number(e.target.value) }))}
            >
              {INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {L.intervalLabels[m]}
                </option>
              ))}
            </Select>
          </Field>
          <label
            style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" }}
          >
            <Toggle on={schedForm.enabled} onChange={(v) => setSchedForm((f) => ({ ...f, enabled: v }))} testId="settings-schedule-form-enabled-toggle" ariaLabel={L.enabled} />
            {L.enabled}
          </label>
          {schedFormError && <div className="error-text" style={{ fontSize: 13 }}>{schedFormError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="settings-schedule-cancel-button" onClick={() => setSchedModalOpen(false)}>
              {L.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              testId="settings-schedule-submit-button"
              disabled={schedBusy || !schedForm.name.trim() || !schedForm.environment_id}
            >
              {schedEditing ? L.save : L.create}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ---------- Schedule delete confirm ---------- */}
      <Modal open={!!schedDeleting} onClose={() => setSchedDeleting(null)} title={L.delSchedTitle} testId="settings-schedule-delete-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{schedDeleting?.name}</div>
            {L.delSchedConfirm}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="settings-schedule-delete-cancel-button" onClick={() => setSchedDeleting(null)}>
              {L.cancel}
            </Button>
            <Button variant="danger" testId="settings-schedule-delete-confirm-button" disabled={schedDeleteBusy} onClick={deleteSched}>
              {L.confirm}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
