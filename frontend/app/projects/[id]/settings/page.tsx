"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useParams } from "next/navigation";
import { API, api, getToken } from "@/lib/api";
import { useLang } from "@/lib/i18n";
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
function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
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
          insetInlineStart: on ? 17 : 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          background: "#F2EFF7",
          transition: "inset-inline-start 120ms ease-out",
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
  const { lang } = useLang();
  const ar = lang === "ar";

  const L = ar
    ? {
        title: "الإعدادات",
        sub: "مفاتيح الوصول والجدولة وتصدير البيانات",
        tabKeys: "مفاتيح API",
        tabSchedules: "الجدولة",
        tabExport: "تصدير البيانات",
        loading: "جارٍ التحميل…",
        retry: "إعادة المحاولة",
        loadError: "تعذّر التحميل",
        // keys
        keysTitle: "مفاتيح API",
        keysSub: "مفاتيح للوصول البرمجي وبوابة CI/CD — تُرسل في الترويسة X-API-Key",
        newKey: "مفتاح جديد",
        keyName: "اسم المفتاح",
        keyPrefix: "البادئة",
        created: "تاريخ الإنشاء",
        lastUsed: "آخر استخدام",
        state: "الحالة",
        active: "فعّال",
        revoked: "مُلغى",
        revoke: "إلغاء",
        revokeTitle: "إلغاء المفتاح",
        revokeConfirm: "سيتوقف هذا المفتاح عن العمل فورًا ولا يمكن التراجع. متابعة؟",
        confirm: "تأكيد",
        cancel: "إلغاء",
        create: "إنشاء",
        creating: "جارٍ الإنشاء…",
        keyCreated: "تم إنشاء المفتاح",
        keyOnceWarning: "لن يُعرض المفتاح مرة أخرى — انسخه الآن واحفظه في مكان آمن",
        copy: "نسخ",
        copied: "تم النسخ ✓",
        done: "تم",
        keysEmpty: "لا توجد مفاتيح بعد",
        keysEmptyHint: "أنشئ مفتاحًا لاستخدامه في CI/CD أو الوصول البرمجي",
        // schedules
        schedTitle: "الجدولة",
        schedSub: "تشغيلات دورية تلقائية للحالات المعتمدة",
        newSched: "جدولة جديدة",
        editSched: "تعديل الجدولة",
        schedName: "اسم الجدولة",
        env: "البيئة",
        pickEnv: "اختر بيئة…",
        interval: "الفاصل الزمني",
        intervalLabels: {
          15: "كل 15 دقيقة",
          30: "كل 30 دقيقة",
          60: "كل ساعة",
          360: "كل 6 ساعات",
          1440: "يوميًا",
        } as Record<number, string>,
        enabled: "مفعّلة",
        disabled: "معطّلة",
        lastRun: "آخر تشغيل",
        nextRun: "التشغيل القادم",
        actions: "إجراءات",
        edit: "تعديل",
        del: "حذف",
        delSchedTitle: "حذف الجدولة",
        delSchedConfirm: "سيتم حذف هذه الجدولة نهائيًا. متابعة؟",
        save: "حفظ",
        schedEmpty: "لا توجد جدولات بعد",
        schedEmptyHint: "أنشئ جدولة لتشغيل الحالات المعتمدة تلقائيًا على بيئة",
        noEnvs: "لا توجد بيئات — أنشئ بيئة أولاً من صفحة البيئات",
        // export
        exportTitle: "تصدير البيانات",
        exportSub: "تصدير كامل لبيانات المنشأة",
        pdplNote:
          "امتثالًا لنظام حماية البيانات الشخصية (PDPL)، يمكنك تصدير نسخة كاملة من بيانات منشأتك: المشاريع والمتطلبات وحالات الاختبار وملخصات التشغيلات — بصيغة JSON. لا تتضمن النسخة الأسرار المخزّنة ولا أدلة التنفيذ.",
        exportBtn: "تنزيل نسخة البيانات (JSON)",
        exporting: "جارٍ التصدير…",
        exportError: "تعذّر التصدير",
      }
    : {
        title: "Settings",
        sub: "Access keys, scheduling and data export",
        tabKeys: "API keys",
        tabSchedules: "Schedules",
        tabExport: "Data export",
        loading: "Loading…",
        retry: "Retry",
        loadError: "Failed to load",
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
    <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>{L.loading}</div>
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
    <div className="stack">
      <PageHeader title={L.title} sub={L.sub} />

      <div className="row" style={{ gap: 6 }}>
        <Pill active={tab === "keys"} onClick={() => setTab("keys")}>
          {L.tabKeys}
        </Pill>
        <Pill active={tab === "schedules"} onClick={() => setTab("schedules")}>
          {L.tabSchedules}
        </Pill>
        <Pill active={tab === "export"} onClick={() => setTab("export")}>
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
            <Button variant="primary" size="sm" onClick={() => { setKeyFormError(null); setCreatedKey(null); setKeyModalOpen(true); }}>
              + {L.newKey}
            </Button>
          }
          pad={false}
        >
          <div style={{ padding: "8px 16px 0", fontSize: 12, color: "var(--text-muted)" }}>{L.keysSub}</div>
          {keysLoading ? (
            loadingBox
          ) : keysError ? (
            errorBox(keysError, loadKeys)
          ) : keys.length === 0 ? (
            <Empty title={L.keysEmpty} hint={L.keysEmptyHint} />
          ) : (
            <Table head={[L.keyName, L.keyPrefix, L.created, L.lastUsed, L.state, L.actions]}>
              {keys.map((k) => (
                <tr key={k.id} style={k.revoked ? { opacity: 0.55 } : undefined}>
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
                    <Badge tone={k.revoked ? "muted" : "success"}>{k.revoked ? L.revoked : L.active}</Badge>
                  </td>
                  <td>
                    {!k.revoked && (
                      <Button variant="danger" size="sm" onClick={() => setRevoking(k)}>
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
            <Button variant="primary" size="sm" onClick={openSchedCreate} disabled={envs.length === 0}>
              + {L.newSched}
            </Button>
          }
          pad={false}
        >
          <div style={{ padding: "8px 16px 0", fontSize: 12, color: "var(--text-muted)" }}>{L.schedSub}</div>
          {schedLoading ? (
            loadingBox
          ) : schedError ? (
            errorBox(schedError, loadScheds)
          ) : scheds.length === 0 ? (
            <Empty title={L.schedEmpty} hint={envs.length === 0 ? L.noEnvs : L.schedEmptyHint} />
          ) : (
            <Table head={[L.schedName, L.env, L.interval, L.state, L.lastRun, L.nextRun, L.actions]}>
              {scheds.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontSize: 13, color: "var(--text)" }}>{s.name}</td>
                  <td style={{ fontSize: 13, color: "var(--text-secondary)" }}>{envName(s.environment_id)}</td>
                  <td style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    {L.intervalLabels[s.interval_minutes] ?? (
                      <Mono style={{ fontSize: 12 }}>{s.interval_minutes}m</Mono>
                    )}
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      <Toggle on={s.enabled} onChange={(v) => toggleSched(s, v)} />
                      <span style={{ fontSize: 12, color: s.enabled ? "var(--success)" : "var(--text-muted)" }}>
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
                      <Button variant="ghost" size="sm" onClick={() => openSchedEdit(s)}>
                        {L.edit}
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => setSchedDeleting(s)}>
                        {L.del}
                      </Button>
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
            <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{L.exportSub}</div>
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
              <Button variant="primary" disabled={exporting} onClick={runExport}>
                {exporting ? L.exporting : `⇩ ${L.exportBtn}`}
              </Button>
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
      >
        {createdKey ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{createdKey.name}</div>
            <div
              className="code-block"
              dir="ltr"
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
                placeholder={ar ? "مثال: CI Pipeline" : "e.g. CI Pipeline"}
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </Field>
            {keyFormError && <div className="error-text" style={{ fontSize: 13 }}>{keyFormError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="ghost" onClick={() => setKeyModalOpen(false)}>
                {L.cancel}
              </Button>
              <Button type="submit" variant="primary" disabled={keyBusy || !keyName.trim()}>
                {keyBusy ? L.creating : L.create}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- Revoke confirm ---------- */}
      <Modal open={!!revoking} onClose={() => setRevoking(null)} title={L.revokeTitle}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
              {revoking?.name} — <Mono style={{ fontSize: 12 }}>{revoking?.prefix}…</Mono>
            </div>
            {L.revokeConfirm}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {L.cancel}
            </Button>
            <Button variant="danger" disabled={revokeBusy} onClick={revokeKey}>
              {L.confirm}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---------- Schedule modal ---------- */}
      <Modal open={schedModalOpen} onClose={() => setSchedModalOpen(false)} title={schedEditing ? L.editSched : L.newSched}>
        <form onSubmit={saveSched} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.schedName}>
            <Input
              required
              maxLength={100}
              placeholder={ar ? "مثال: تشغيل ليلي" : "e.g. Nightly run"}
              value={schedForm.name}
              onChange={(e) => setSchedForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label={L.env}>
            <Select
              required
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
            <Toggle on={schedForm.enabled} onChange={(v) => setSchedForm((f) => ({ ...f, enabled: v }))} />
            {L.enabled}
          </label>
          {schedFormError && <div className="error-text" style={{ fontSize: 13 }}>{schedFormError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setSchedModalOpen(false)}>
              {L.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={schedBusy || !schedForm.name.trim() || !schedForm.environment_id}
            >
              {schedEditing ? L.save : L.create}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ---------- Schedule delete confirm ---------- */}
      <Modal open={!!schedDeleting} onClose={() => setSchedDeleting(null)} title={L.delSchedTitle}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{schedDeleting?.name}</div>
            {L.delSchedConfirm}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setSchedDeleting(null)}>
              {L.cancel}
            </Button>
            <Button variant="danger" disabled={schedDeleteBusy} onClick={deleteSched}>
              {L.confirm}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
