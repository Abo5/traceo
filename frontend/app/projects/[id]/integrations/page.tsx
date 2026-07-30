"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  RefChip,
  Select,
  Table,
} from "@/components/ui";

type Integration = {
  id: string;
  type: "jira" | "xray" | "confluence" | "slack";
  name: string;
  project_id: string | null;
  config: Record<string, any>;
  secret_set: boolean;
  secret_rotated_at: string | null;
  state: "configured" | "connected" | "error";
  last_error: string | null;
  last_checked_at: string | null;
  alert_level: string;
};

type Gate = {
  enabled: boolean;
  min_coverage_pct: number;
  max_new_failures: number;
  block_on: string;
};

type Schedule = {
  id: string;
  environment_id: string;
  cron: string;
  timezone: string;
  branch: string;
  enabled: boolean;
  next_due_at: string | null;
  last_fired_at: string | null;
};

type Env = { id: string; name: string };

/** Which non-secret fields each integration type needs, and which key is the secret. */
const TYPE_FIELDS: Record<string, { config: string[]; secret: string | null }> = {
  jira: { config: ["base_url", "project_key", "email", "issue_type"], secret: "api_token" },
  xray: { config: ["base_url"], secret: "api_token" },
  confluence: { config: ["base_url", "space_key", "email"], secret: "api_token" },
  slack: { config: ["webhook_url"], secret: "webhook_url" },
};

const STATE_TONE = { connected: "success", error: "error", configured: "muted" } as const;

export default function IntegrationsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const { lang } = useLang();
  const ar = lang === "ar";

  const L = ar
    ? {
        title: "التكاملات",
        sub: "أوصل Traceo بالأدوات التي يعمل عليها الفريق — Jira وXray وConfluence وSlack — واضبط بوابة التسليم",
        add: "تكامل جديد",
        edit: "تعديل التكامل",
        type: "النوع",
        name: "الاسم",
        state: "الحالة",
        lastChecked: "آخر فحص",
        actions: "إجراءات",
        check: "فحص الاتصال",
        checking: "جارٍ الفحص…",
        del: "حذف",
        save: "حفظ",
        cancel: "إلغاء",
        create: "إنشاء",
        secret: "السر",
        secretHint: "يُحفظ مشفّراً ولا يُعرض بعد الحفظ — اتركه فارغاً للإبقاء على السر الحالي",
        secretSet: "سر محفوظ",
        rotated: "آخر تدوير",
        alertLevel: "مستوى التنبيه",
        alertLevels: { all: "كل التشغيلات", failures: "الإخفاقات فقط", regressions: "الانحدارات فقط" } as Record<string, string>,
        empty: "لا توجد تكاملات بعد",
        emptyHint: "أضف Jira لتصدير العيوب، أو Confluence لاستيراد المتطلبات، أو Slack للتنبيهات",
        gate: "بوابة التسليم",
        gateSub: "تفشل خطوة CI عندما تنخفض التغطية أو ينحدر متطلب",
        gateEnabled: "مفعّلة",
        minCoverage: "الحد الأدنى للتغطية %",
        maxNewFailures: "أقصى إخفاقات جديدة",
        blockOn: "المنع عند",
        blockOnOpts: { any: "أي إخفاق", high_priority: "متطلب عالي الأولوية", none: "لا شيء" } as Record<string, string>,
        gateSaved: "حُفظت السياسة",
        ci: "خطوة CI",
        ciHint: "انسخ هذه الخطوة إلى خط الأنابيب — تحتاج رمز API من الإعدادات",
        schedules: "التشغيل المجدول",
        schedulesSub: "cron لكل بيئة — التوقيت الافتراضي بتوقيت السعودية",
        cron: "تعبير cron",
        timezone: "المنطقة الزمنية",
        branch: "الفرع",
        environment: "البيئة",
        nextDue: "التشغيل القادم",
        addSchedule: "جدولة جديدة",
        enabled: "مفعّل",
        disabled: "معطّل",
        confluence: "استيراد من Confluence",
        loadPages: "عرض الصفحات",
        importSelected: "استيراد المحدد",
        pages: "الصفحات",
        noPages: "لا توجد صفحات في هذا الفضاء",
        imported: "بدأ استيراد الصفحات المحددة",
        loading: "جارٍ التحميل…",
      }
    : {
        title: "Integrations",
        sub: "Connect Traceo to where the team already works — Jira, Xray, Confluence, Slack — and set the delivery gate",
        add: "New integration",
        edit: "Edit integration",
        type: "Type",
        name: "Name",
        state: "State",
        lastChecked: "Last checked",
        actions: "Actions",
        check: "Check connection",
        checking: "Checking…",
        del: "Delete",
        save: "Save",
        cancel: "Cancel",
        create: "Create",
        secret: "Secret",
        secretHint: "Stored encrypted and never shown again — leave blank to keep the current one",
        secretSet: "Secret stored",
        rotated: "Last rotated",
        alertLevel: "Alert level",
        alertLevels: { all: "All runs", failures: "Failures only", regressions: "Regressions only" } as Record<string, string>,
        empty: "No integrations yet",
        emptyHint: "Add Jira to export defects, Confluence to import requirements, or Slack for alerts",
        gate: "Delivery gate",
        gateSub: "Fail the pipeline when coverage drops or a requirement regresses",
        gateEnabled: "Enabled",
        minCoverage: "Minimum coverage %",
        maxNewFailures: "Max new failures",
        blockOn: "Block on",
        blockOnOpts: { any: "Any failure", high_priority: "High-priority requirement", none: "Nothing" } as Record<string, string>,
        gateSaved: "Policy saved",
        ci: "CI step",
        ciHint: "Copy this into your pipeline — it needs an API token from Settings",
        schedules: "Scheduled runs",
        schedulesSub: "Cron per environment — Arabia Standard Time by default",
        cron: "Cron expression",
        timezone: "Timezone",
        branch: "Branch",
        environment: "Environment",
        nextDue: "Next due",
        addSchedule: "New schedule",
        enabled: "Enabled",
        disabled: "Disabled",
        confluence: "Import from Confluence",
        loadPages: "List pages",
        importSelected: "Import selected",
        pages: "Pages",
        noPages: "No pages in this space",
        imported: "Import started for the selected pages",
        loading: "Loading…",
      };

  const [rows, setRows] = useState<Integration[]>([]);
  const [envs, setEnvs] = useState<Env[]>([]);
  const [gate, setGate] = useState<Gate | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [modal, setModal] = useState<{ open: boolean; editing: Integration | null }>({
    open: false,
    editing: null,
  });
  const [form, setForm] = useState<Record<string, string>>({ type: "jira", name: "" });
  const [scheduleModal, setScheduleModal] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    environment_id: "",
    cron: "0 2 * * *",
    timezone: "Asia/Riyadh",
    branch: "",
  });
  const [pages, setPages] = useState<{ integration: string; items: any[] } | null>(null);
  const [selectedPages, setSelectedPages] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ints, gatePolicy, scheds, envList] = await Promise.all([
        api<{ integrations: Integration[] }>(`/integrations?project_id=${projectId}`),
        api<Gate>(`/projects/${projectId}/gate`),
        api<{ schedules: Schedule[] }>(`/projects/${projectId}/schedules`),
        api<any>(`/projects/${projectId}/environments`),
      ]);
      setRows(ints.integrations ?? []);
      setGate(gatePolicy);
      setSchedules(scheds.schedules ?? []);
      setEnvs(Array.isArray(envList) ? envList : envList?.environments ?? []);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setForm({ type: "jira", name: "" });
    setModal({ open: true, editing: null });
  }

  function openEdit(row: Integration) {
    const next: Record<string, string> = { type: row.type, name: row.name };
    for (const key of TYPE_FIELDS[row.type].config) next[key] = row.config?.[key] ?? "";
    next.alert_level = row.alert_level;
    setForm(next);
    setModal({ open: true, editing: row });
  }

  async function submit() {
    const spec = TYPE_FIELDS[form.type];
    const config: Record<string, string> = {};
    for (const key of spec.config) if (form[key]) config[key] = form[key];
    const secretValue = spec.secret ? form.__secret : "";

    setBusy("form");
    setError(null);
    try {
      if (modal.editing) {
        const body: Record<string, any> = { name: form.name, config };
        if (form.type === "slack") body.alert_level = form.alert_level;
        if (secretValue) body.secret = { [spec.secret as string]: secretValue };
        await api(`/integrations/${modal.editing.id}`, { method: "PATCH", body });
      } else {
        await api(`/integrations`, {
          body: {
            type: form.type,
            name: form.name || form.type,
            project_id: projectId,
            config,
            alert_level: form.alert_level || "failures",
            ...(secretValue ? { secret: { [spec.secret as string]: secretValue } } : {}),
          },
        });
      }
      setModal({ open: false, editing: null });
      await load();
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function check(row: Integration) {
    setBusy(row.id);
    try {
      await api(`/integrations/${row.id}/check`, { body: {} });
      await load();
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: Integration) {
    setBusy(row.id);
    try {
      await api(`/integrations/${row.id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveGate() {
    if (!gate) return;
    setBusy("gate");
    setError(null);
    try {
      const saved = await api<Gate>(`/projects/${projectId}/gate`, { method: "PUT", body: gate });
      setGate(saved);
      setNote(L.gateSaved);
      setTimeout(() => setNote(null), 2500);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addSchedule() {
    setBusy("schedule");
    setError(null);
    try {
      await api(`/projects/${projectId}/schedules`, { body: scheduleForm });
      setScheduleModal(false);
      await load();
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function toggleSchedule(s: Schedule) {
    setBusy(s.id);
    try {
      await api(`/schedules/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function deleteSchedule(s: Schedule) {
    setBusy(s.id);
    try {
      await api(`/schedules/${s.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function listPages(row: Integration) {
    setBusy(row.id);
    setError(null);
    try {
      const res = await api<any>(`/integrations/${row.id}/confluence/pages`);
      setPages({ integration: row.id, items: res.pages ?? [] });
      setSelectedPages([]);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function importPages() {
    if (!pages) return;
    setBusy("import");
    setError(null);
    try {
      await api(`/projects/${projectId}/confluence/import`, {
        body: { integration_id: pages.integration, page_ids: selectedPages },
      });
      setPages(null);
      setNote(L.imported);
      setTimeout(() => setNote(null), 3000);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const ciSnippet = `- name: Traceo gate
  run: |
    RUN=$(curl -sf -X POST "$TRACEO_URL/v1/projects/${projectId}/ci/runs" \\
      -H "Authorization: Bearer $TRACEO_TOKEN" -H "Content-Type: application/json" \\
      -d '{"environment_id":"<env-id>","branch":"'"$GITHUB_REF_NAME"'"}' | jq -r .run_id)
    until [ "$(curl -sf "$TRACEO_URL/v1/runs/$RUN" -H "Authorization: Bearer $TRACEO_TOKEN" \\
      | jq -r .state)" != "running" ]; do sleep 5; done
    curl -sf "$TRACEO_URL/v1/runs/$RUN/gate" -H "Authorization: Bearer $TRACEO_TOKEN" \\
      | tee gate.json | jq -e '.passed' >/dev/null || { jq -r '.breaches[].message' gate.json; exit 1; }`;

  const spec = TYPE_FIELDS[form.type] ?? TYPE_FIELDS.jira;
  const confluence = rows.filter((r) => r.type === "confluence");

  return (
    <>
      <PageHeader
        title={
          <>
            {L.title} <RefChip id="FR-070" />
          </>
        }
        sub={L.sub}
        actions={<Button onClick={openCreate}>{L.add}</Button>}
      />

      {error && (
        <div className="card" style={{ borderColor: "var(--error)", marginBottom: 16 }}>
          <div className="card-body" style={{ color: "var(--error)" }}>{error}</div>
        </div>
      )}
      {note && (
        <div className="card" style={{ borderColor: "var(--success)", marginBottom: 16 }}>
          <div className="card-body" style={{ color: "var(--success)" }}>{note}</div>
        </div>
      )}

      {/* ---------------- connected systems ---------------- */}
      <Card title={L.title} pad={false}>
        {loading ? (
          <div className="card-body">{L.loading}</div>
        ) : rows.length === 0 ? (
          <div className="card-body">
            <Empty icon="🔌" title={L.empty} hint={L.emptyHint} />
          </div>
        ) : (
          <Table head={[L.type, L.name, L.state, L.lastChecked, L.actions]}>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Badge tone="accent">{row.type}</Badge>
                </td>
                <td>
                  <div>{row.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }} dir="ltr">
                    {row.config?.base_url || row.config?.webhook_url || ""}
                  </div>
                  {row.secret_set && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {L.secretSet} · {L.rotated}:{" "}
                      {row.secret_rotated_at ? row.secret_rotated_at.slice(0, 10) : "—"}
                    </div>
                  )}
                  {row.type === "slack" && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {L.alertLevel}: {L.alertLevels[row.alert_level] ?? row.alert_level}
                    </div>
                  )}
                </td>
                <td>
                  <Badge tone={STATE_TONE[row.state] ?? "muted"}>{row.state}</Badge>
                  {row.last_error && (
                    <div style={{ fontSize: 11, color: "var(--error)", maxWidth: 320 }}>
                      {row.last_error}
                    </div>
                  )}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {row.last_checked_at ? row.last_checked_at.slice(0, 16).replace("T", " ") : "—"}
                </td>
                <td>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <Button size="sm" variant="ghost" onClick={() => check(row)} disabled={busy === row.id}>
                      {busy === row.id ? L.checking : L.check}
                    </Button>
                    {row.type === "confluence" && (
                      <Button size="sm" variant="ghost" onClick={() => listPages(row)} disabled={busy === row.id}>
                        {L.loadPages}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
                      {ar ? "تعديل" : "Edit"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(row)} disabled={busy === row.id}>
                      {L.del}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ---------------- Confluence page picker ---------------- */}
      {pages && (
        <Card
          title={
            <>
              {L.confluence} <RefChip id="FR-011" />
            </>
          }
          action={
            <Button onClick={importPages} disabled={!selectedPages.length || busy === "import"}>
              {L.importSelected} ({selectedPages.length})
            </Button>
          }
          style={{ marginTop: 16 }}
        >
          {pages.items.length === 0 ? (
            <Empty icon="📄" title={L.noPages} />
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {pages.items.map((p: any) => (
                <label key={p.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={selectedPages.includes(p.id)}
                    onChange={(e) =>
                      setSelectedPages((prev) =>
                        e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id)
                      )
                    }
                  />
                  <span>{p.title}</span>
                  <Badge tone="muted">v{p.version}</Badge>
                </label>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ---------------- delivery gate ---------------- */}
      <Card
        title={
          <>
            {L.gate} <RefChip id="FR-061" />
          </>
        }
        action={
          <Button onClick={saveGate} disabled={busy === "gate" || !gate}>
            {L.save}
          </Button>
        }
        style={{ marginTop: 16 }}
      >
        <div className="page-sub" style={{ marginBottom: 12 }}>{L.gateSub}</div>
        {gate && (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))" }}>
            <Field label={L.gateEnabled}>
              <Select
                value={gate.enabled ? "1" : "0"}
                onChange={(e) => setGate({ ...gate, enabled: e.target.value === "1" })}
              >
                <option value="1">{L.enabled}</option>
                <option value="0">{L.disabled}</option>
              </Select>
            </Field>
            <Field label={L.minCoverage}>
              <Input
                type="number"
                min={0}
                max={100}
                value={gate.min_coverage_pct}
                onChange={(e) => setGate({ ...gate, min_coverage_pct: Number(e.target.value) })}
              />
            </Field>
            <Field label={L.maxNewFailures}>
              <Input
                type="number"
                min={0}
                value={gate.max_new_failures}
                onChange={(e) => setGate({ ...gate, max_new_failures: Number(e.target.value) })}
              />
            </Field>
            <Field label={L.blockOn}>
              <Select value={gate.block_on} onChange={(e) => setGate({ ...gate, block_on: e.target.value })}>
                {["any", "high_priority", "none"].map((v) => (
                  <option key={v} value={v}>
                    {L.blockOnOpts[v]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>{L.ci}</div>
          <div className="field-hint" style={{ marginBottom: 6 }}>{L.ciHint}</div>
          <pre
            className="mono"
            dir="ltr"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "12px 14px",
              overflowX: "auto",
              fontSize: 11.5,
              lineHeight: 1.6,
              margin: 0,
              textAlign: "left",
            }}
          >
            {ciSnippet}
          </pre>
        </div>
      </Card>

      {/* ---------------- schedules ---------------- */}
      <Card
        title={
          <>
            {L.schedules} <RefChip id="FR-060" />
          </>
        }
        action={
          <Button
            onClick={() => {
              setScheduleForm((f) => ({ ...f, environment_id: envs[0]?.id ?? "" }));
              setScheduleModal(true);
            }}
            disabled={!envs.length}
          >
            {L.addSchedule}
          </Button>
        }
        style={{ marginTop: 16 }}
        pad={schedules.length === 0}
      >
        {schedules.length === 0 ? (
          <>
            <div className="page-sub" style={{ marginBottom: 8 }}>{L.schedulesSub}</div>
            <Empty icon="⏱" title={L.schedulesSub} />
          </>
        ) : (
          <Table head={[L.cron, L.environment, L.branch, L.nextDue, L.state, L.actions]}>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td className="mono" dir="ltr">{s.cron}</td>
                <td>{envs.find((e) => e.id === s.environment_id)?.name ?? s.environment_id.slice(0, 8)}</td>
                <td className="mono">{s.branch || "—"}</td>
                <td className="mono" style={{ fontSize: 11 }} dir="ltr">
                  {s.next_due_at ? s.next_due_at.slice(0, 16).replace("T", " ") : "—"}
                  <div style={{ color: "var(--text-muted)" }}>{s.timezone}</div>
                </td>
                <td>
                  <Badge tone={s.enabled ? "success" : "muted"}>
                    {s.enabled ? L.enabled : L.disabled}
                  </Badge>
                </td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <Button size="sm" variant="ghost" onClick={() => toggleSchedule(s)} disabled={busy === s.id}>
                      {s.enabled ? L.disabled : L.enabled}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteSchedule(s)} disabled={busy === s.id}>
                      {L.del}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* ---------------- modals ---------------- */}
      <Modal
        open={modal.open}
        onClose={() => setModal({ open: false, editing: null })}
        title={modal.editing ? L.edit : L.add}
      >
        <div style={{ display: "grid", gap: 12 }}>
          <Field label={L.type}>
            <Select
              value={form.type}
              disabled={!!modal.editing}
              onChange={(e) => setForm({ type: e.target.value, name: form.name })}
            >
              {Object.keys(TYPE_FIELDS).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label={L.name}>
            <Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          {spec.config.map((key) => (
            <Field key={key} label={key.replace(/_/g, " ")}>
              <Input
                dir="ltr"
                value={form[key] ?? ""}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </Field>
          ))}
          {form.type === "slack" && (
            <Field label={L.alertLevel}>
              <Select
                value={form.alert_level ?? "failures"}
                onChange={(e) => setForm({ ...form, alert_level: e.target.value })}
              >
                {["all", "failures", "regressions"].map((v) => (
                  <option key={v} value={v}>{L.alertLevels[v]}</option>
                ))}
              </Select>
            </Field>
          )}
          {spec.secret && (
            <Field label={L.secret} hint={L.secretHint}>
              <Input
                dir="ltr"
                type="password"
                autoComplete="new-password"
                value={form.__secret ?? ""}
                onChange={(e) => setForm({ ...form, __secret: e.target.value })}
              />
            </Field>
          )}
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setModal({ open: false, editing: null })}>
              {L.cancel}
            </Button>
            <Button onClick={submit} disabled={busy === "form"}>
              {modal.editing ? L.save : L.create}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={scheduleModal} onClose={() => setScheduleModal(false)} title={L.addSchedule}>
        <div style={{ display: "grid", gap: 12 }}>
          <Field label={L.environment}>
            <Select
              value={scheduleForm.environment_id}
              onChange={(e) => setScheduleForm({ ...scheduleForm, environment_id: e.target.value })}
            >
              {envs.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={L.cron} hint="m h dom mon dow — 0 2 * * *">
            <Input
              dir="ltr"
              value={scheduleForm.cron}
              onChange={(e) => setScheduleForm({ ...scheduleForm, cron: e.target.value })}
            />
          </Field>
          <Field label={L.timezone}>
            <Input
              dir="ltr"
              value={scheduleForm.timezone}
              onChange={(e) => setScheduleForm({ ...scheduleForm, timezone: e.target.value })}
            />
          </Field>
          <Field label={L.branch}>
            <Input
              dir="ltr"
              value={scheduleForm.branch}
              onChange={(e) => setScheduleForm({ ...scheduleForm, branch: e.target.value })}
            />
          </Field>
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setScheduleModal(false)}>{L.cancel}</Button>
            <Button onClick={addSchedule} disabled={busy === "schedule"}>{L.create}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
