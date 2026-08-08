"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, api, getToken } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { useCan } from "@/lib/permissions";
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
  RefChip,
  Select,
} from "@/components/ui";

type Webhook = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  last_status?: number | null;
  last_fired_at?: string | null;
  secret_set?: boolean;
};

type Gate = {
  pass: boolean;
  coverage_pct?: number;
  open_defects?: { total?: number; critical?: number };
  latest_run?: { id?: string; display_id?: number | string; counts?: Record<string, number> };
  breaches?: { check: string; limit: number | string; actual: number | string; requirement_external_ids?: string[] }[];
};

type Run = { id: string; display_id?: number | string; state?: string };

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.runs ?? [];
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

function CopyButton({ text, label, copied }: { text: string; label: string; copied: string }) {
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
      {done ? copied : label}
    </Button>
  );
}

export default function IntegrationsPage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useLang();
  const ar = lang === "ar";
  const canDo = useCan();

  const L = ar
    ? {
        title: "التكاملات",
        sub: "اربط Traceo بأدوات فريقك — إشعارات، بوابة CI/CD، وتصدير Jira/Xray",
        loading: "جارٍ التحميل…",
        retry: "إعادة المحاولة",
        loadError: "تعذّر التحميل",
        // webhooks
        whTitle: "Webhooks",
        whSub: "إشعار عند اكتمال أي تشغيل — يعمل مع Slack Incoming Webhooks",
        whSlackHint: "تلميح: الصق رابط Slack Incoming Webhook لاستقبال ملخص عربي في قناتك",
        newWh: "إضافة Webhook",
        editWh: "تعديل Webhook",
        whName: "الاسم",
        whUrl: "الرابط (URL)",
        whSecret: "السر (اختياري)",
        whSecretHint: "يُستخدم لتوقيع HMAC-SHA256 في الترويسة X-Traceo-Signature — اتركه فارغًا للإبقاء على الحالي",
        enabled: "مفعّل",
        disabled: "معطّل",
        test: "اختبار",
        testing: "جارٍ الاختبار…",
        lastStatus: "آخر حالة",
        lastFired: "آخر إرسال",
        edit: "تعديل",
        del: "حذف",
        delWhTitle: "حذف Webhook",
        delWhConfirm: "سيتم حذف هذا الـ Webhook نهائيًا. متابعة؟",
        confirm: "تأكيد",
        cancel: "إلغاء",
        create: "إنشاء",
        save: "حفظ",
        saving: "جارٍ الحفظ…",
        whEmpty: "لا توجد Webhooks بعد",
        whEmptyHint: "أضف رابطًا لاستقبال إشعار عند اكتمال التشغيلات",
        // gate
        gateTitle: "بوابة CI/CD",
        gateSub: "أوقف الدمج عندما تنخفض التغطية أو توجد عيوب حرجة",
        minCoverage: "الحد الأدنى للتغطية %",
        maxCritical: "الحد الأقصى للعيوب الحرجة",
        checkGate: "فحص البوابة",
        checking: "جارٍ الفحص…",
        gatePass: "البوابة تسمح بالمرور ✓",
        gateFail: "البوابة توقف الدمج",
        coverage: "التغطية",
        criticalDefects: "عيوب حرجة",
        breach: "خرق",
        limit: "الحد",
        actual: "الفعلي",
        curlHint: "أضف هذا الأمر إلى خط CI — أنشئ مفتاح API من صفحة الإعدادات",
        copy: "نسخ",
        copied: "تم النسخ ✓",
        // xray
        xrayTitle: "Jira / Xray",
        xraySub: "صدّر نتائج تشغيل بصيغة Xray أو ملف عيوب قابل للاستيراد في Jira",
        pickRun: "اختر تشغيلًا…",
        run: "التشغيل",
        dlXray: "تنزيل xray.json",
        dlDefects: "تنزيل defects.csv",
        dlError: "تعذّر التنزيل",
        noRuns: "لا توجد تشغيلات بعد — شغّل الحالات المعتمدة أولًا",
        // soon
        soon: "قريباً",
        confluenceTitle: "Confluence",
        confluenceSub: "استيراد صفحات المتطلبات مباشرة بدلًا من رفع الملفات",
        jiraSyncTitle: "مزامنة Jira",
        jiraSyncSub: "مزامنة مباشرة ثنائية الاتجاه مع مشاريع Jira",
      }
    : {
        title: "Integrations",
        sub: "Connect Traceo to your team's tools — notifications, CI/CD gate and Jira/Xray export",
        loading: "Loading…",
        retry: "Retry",
        loadError: "Failed to load",
        whTitle: "Webhooks",
        whSub: "Notify on run completion — works with Slack Incoming Webhooks",
        whSlackHint: "Tip: paste a Slack Incoming Webhook URL to get an Arabic summary in your channel",
        newWh: "Add webhook",
        editWh: "Edit webhook",
        whName: "Name",
        whUrl: "URL",
        whSecret: "Secret (optional)",
        whSecretHint: "Used for the HMAC-SHA256 X-Traceo-Signature header — leave blank to keep the current one",
        enabled: "Enabled",
        disabled: "Disabled",
        test: "Test",
        testing: "Testing…",
        lastStatus: "Last status",
        lastFired: "Last fired",
        edit: "Edit",
        del: "Delete",
        delWhTitle: "Delete webhook",
        delWhConfirm: "This webhook will be permanently deleted. Continue?",
        confirm: "Confirm",
        cancel: "Cancel",
        create: "Create",
        save: "Save",
        saving: "Saving…",
        whEmpty: "No webhooks yet",
        whEmptyHint: "Add a URL to get notified when runs complete",
        gateTitle: "CI/CD Gate",
        gateSub: "Block merges when coverage drops or critical defects exist",
        minCoverage: "Min coverage %",
        maxCritical: "Max critical defects",
        checkGate: "Check gate",
        checking: "Checking…",
        gatePass: "Gate passing ✓",
        gateFail: "Gate blocking the merge",
        coverage: "Coverage",
        criticalDefects: "critical defects",
        breach: "Breach",
        limit: "Limit",
        actual: "Actual",
        curlHint: "Add this command to your CI pipeline — create an API key on the Settings page",
        copy: "Copy",
        copied: "Copied ✓",
        xrayTitle: "Jira / Xray",
        xraySub: "Export run results as Xray import or a Jira-importable defects file",
        pickRun: "Pick a run…",
        run: "Run",
        dlXray: "Download xray.json",
        dlDefects: "Download defects.csv",
        dlError: "Download failed",
        noRuns: "No runs yet — execute approved cases first",
        soon: "Coming soon",
        confluenceTitle: "Confluence",
        confluenceSub: "Pull requirement pages directly instead of uploading files",
        jiraSyncTitle: "Jira sync",
        jiraSyncSub: "Live two-way sync with Jira projects",
      };

  // ---- webhooks ----
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [whLoading, setWhLoading] = useState(true);
  const [whError, setWhError] = useState<string | null>(null);
  const [whModalOpen, setWhModalOpen] = useState(false);
  const [whEditing, setWhEditing] = useState<Webhook | null>(null);
  const [whForm, setWhForm] = useState({ name: "", url: "", secret: "", enabled: true });
  const [whBusy, setWhBusy] = useState(false);
  const [whFormError, setWhFormError] = useState<string | null>(null);
  const [whDeleting, setWhDeleting] = useState<Webhook | null>(null);
  const [whDeleteBusy, setWhDeleteBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; status?: number; error?: string }>>({});

  // ---- gate ----
  const [minCoverage, setMinCoverage] = useState("80");
  const [maxCritical, setMaxCritical] = useState("0");
  const [gate, setGate] = useState<Gate | null>(null);
  const [gateLoading, setGateLoading] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  // ---- xray ----
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runId, setRunId] = useState("");
  const [dlBusy, setDlBusy] = useState<string | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);

  function loadHooks() {
    setWhLoading(true);
    setWhError(null);
    api(`/projects/${id}/webhooks`)
      .then((r) => setHooks(asList(r)))
      .catch((e) => setWhError(e?.message || String(e)))
      .finally(() => setWhLoading(false));
  }

  function loadRuns() {
    setRunsError(null);
    api(`/projects/${id}/runs`)
      .then((r) => {
        const list = asList(r);
        setRuns(list);
        if (list.length > 0) setRunId((prev) => prev || list[0].id);
      })
      .catch((e) => setRunsError(e?.message || String(e)));
  }

  async function loadGate() {
    setGateLoading(true);
    setGateError(null);
    try {
      const params = new URLSearchParams();
      if (minCoverage.trim()) params.set("min_coverage", minCoverage.trim());
      if (maxCritical.trim()) params.set("max_critical", maxCritical.trim());
      const g = await api<Gate>(`/projects/${id}/gate?${params.toString()}`);
      setGate(g);
    } catch (e: any) {
      setGateError(e?.message || String(e));
    } finally {
      setGateLoading(false);
    }
  }

  useEffect(() => {
    loadHooks();
    loadRuns();
    loadGate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function openWhCreate() {
    setWhEditing(null);
    setWhForm({ name: "", url: "", secret: "", enabled: true });
    setWhFormError(null);
    setWhModalOpen(true);
  }

  function openWhEdit(w: Webhook) {
    setWhEditing(w);
    setWhForm({ name: w.name, url: w.url, secret: "", enabled: w.enabled });
    setWhFormError(null);
    setWhModalOpen(true);
  }

  async function saveWh(e: React.FormEvent) {
    e.preventDefault();
    setWhBusy(true);
    setWhFormError(null);
    const body: any = {
      name: whForm.name.trim(),
      url: whForm.url.trim(),
      enabled: whForm.enabled,
    };
    if (whForm.secret.trim()) body.secret = whForm.secret.trim();
    try {
      if (whEditing) {
        await api(`/webhooks/${whEditing.id}`, { method: "PATCH", body });
      } else {
        await api(`/projects/${id}/webhooks`, { body });
      }
      setWhModalOpen(false);
      loadHooks();
    } catch (err: any) {
      setWhFormError(err?.message || String(err));
    } finally {
      setWhBusy(false);
    }
  }

  async function deleteWh() {
    if (!whDeleting) return;
    setWhDeleteBusy(true);
    try {
      await api(`/webhooks/${whDeleting.id}`, { method: "DELETE" });
      setWhDeleting(null);
      loadHooks();
    } catch (e: any) {
      setWhError(e?.message || String(e));
      setWhDeleting(null);
    } finally {
      setWhDeleteBusy(false);
    }
  }

  async function testWh(w: Webhook) {
    setTestingId(w.id);
    try {
      const res = await api<any>(`/webhooks/${w.id}/test`, { method: "POST", body: {} });
      const status = res?.status ?? res?.last_status;
      const ok = res?.ok ?? (typeof status === "number" && status >= 200 && status < 300);
      setTestResults((t) => ({ ...t, [w.id]: { ok, status } }));
      loadHooks();
    } catch (e: any) {
      setTestResults((t) => ({ ...t, [w.id]: { ok: false, error: e?.message || String(e) } }));
    } finally {
      setTestingId(null);
    }
  }

  async function download(kind: "xray" | "defects") {
    if (!runId) return;
    setDlBusy(kind);
    setDlError(null);
    try {
      if (kind === "xray") await downloadFile(`/runs/${runId}/exports/xray.json`, "xray.json");
      else await downloadFile(`/runs/${runId}/exports/defects.csv`, "defects.csv");
    } catch (e: any) {
      setDlError(`${L.dlError} — ${e?.message || String(e)}`);
    } finally {
      setDlBusy(null);
    }
  }

  const curl = `curl -f -H "X-API-Key: $TRACEO_KEY" \\\n  "${API}/projects/${id}/gate?min_coverage=${minCoverage.trim() || "80"}&max_critical=${maxCritical.trim() || "0"}&exit=1"`;

  const statusTone = (s?: number | null) =>
    typeof s === "number" ? (s >= 200 && s < 300 ? "success" : "error") : "muted";

  return (
    <div className="stack" data-testid="integrations-page-root">
      <PageHeader title={L.title} sub={L.sub} testId="integrations-page-header" />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* ---------- Webhooks ---------- */}
        <Card
          title={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {L.whTitle} <RefChip id="FR-070" />
            </span>
          }
          action={
            canDo("manage_projects") ? (
              <Button variant="secondary" size="sm" testId="integrations-webhooks-new-button" onClick={openWhCreate}>
                + {L.newWh}
              </Button>
            ) : undefined
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{L.whSub}</div>
            {whLoading ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 8 }}>{L.loading}</div>
            ) : whError ? (
              <div className="row" style={{ gap: 10 }}>
                <span className="error-text" style={{ fontSize: 13 }}>
                  {L.loadError} — {whError}
                </span>
                <Button variant="secondary" size="sm" onClick={loadHooks}>
                  {L.retry}
                </Button>
              </div>
            ) : hooks.length === 0 ? (
              <Empty title={L.whEmpty} hint={L.whEmptyHint} testId="integrations-webhooks-empty-state" />
            ) : (
              hooks.map((w) => {
                const tr = testResults[w.id];
                return (
                  <div
                    key={w.id}
                    data-testid="integrations-webhook-card"
                    style={{
                      background: "var(--surface-2)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{w.name}</span>
                      <Badge tone={w.enabled ? "success" : "muted"} testId="integrations-webhook-enabled-badge">{w.enabled ? L.enabled : L.disabled}</Badge>
                      {typeof w.last_status === "number" && (
                        <Badge tone={statusTone(w.last_status)}>
                          {L.lastStatus} · <Mono style={{ fontSize: 10.5 }}>{w.last_status}</Mono>
                        </Badge>
                      )}
                      <span style={{ marginInlineStart: "auto", display: "inline-flex", gap: 6 }}>
                        {canDo("manage_projects") && (
                          <Button variant="secondary" size="sm" testId="integrations-webhook-test-button" disabled={testingId === w.id} onClick={() => testWh(w)}>
                            {testingId === w.id ? L.testing : L.test}
                          </Button>
                        )}
                        {canDo("manage_projects") && (
                          <Button variant="ghost" size="sm" testId="integrations-webhook-edit-button" onClick={() => openWhEdit(w)}>
                            {L.edit}
                          </Button>
                        )}
                        {canDo("manage_projects") && (
                          <Button variant="danger" size="sm" testId="integrations-webhook-delete-button" onClick={() => setWhDeleting(w)}>
                            {L.del}
                          </Button>
                        )}
                      </span>
                    </div>
                    <Mono style={{ fontSize: 11.5, color: "var(--text-secondary)", overflowWrap: "anywhere", display: "block" }}>
                      {w.url}
                    </Mono>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      {w.last_fired_at && (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {L.lastFired} <DateTimeText value={w.last_fired_at} style={{ color: "var(--text-secondary)" }} />
                        </span>
                      )}
                      {tr && (
                        <Badge tone={tr.ok ? "success" : "error"}>
                          {tr.ok ? "✓" : "✕"}{" "}
                          {tr.status !== undefined ? <Mono style={{ fontSize: 10.5 }}>{tr.status}</Mono> : tr.error}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{L.whSlackHint}</div>
          </div>
        </Card>

        {/* ---------- CI/CD Gate ---------- */}
        <Card
          title={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {L.gateTitle} <RefChip id="FR-061" />
            </span>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{L.gateSub}</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ width: 160 }}>
                <Field label={L.minCoverage}>
                  <Input
                    dir="ltr"
                    type="number"
                    min={0}
                    max={100}
                    testId="integrations-gate-min-coverage-input"
                    value={minCoverage}
                    onChange={(e) => setMinCoverage(e.target.value)}
                  />
                </Field>
              </div>
              <div style={{ width: 160 }}>
                <Field label={L.maxCritical}>
                  <Input
                    dir="ltr"
                    type="number"
                    min={0}
                    testId="integrations-gate-max-critical-input"
                    value={maxCritical}
                    onChange={(e) => setMaxCritical(e.target.value)}
                  />
                </Field>
              </div>
              <div style={{ paddingBottom: 2 }}>
                <Button variant="secondary" size="sm" testId="integrations-gate-check-button" disabled={gateLoading} onClick={loadGate}>
                  {gateLoading ? L.checking : L.checkGate}
                </Button>
              </div>
            </div>

            {gateError ? (
              <div className="row" style={{ gap: 10 }}>
                <span className="error-text" style={{ fontSize: 13 }}>
                  {L.loadError} — {gateError}
                </span>
                <Button variant="secondary" size="sm" onClick={loadGate}>
                  {L.retry}
                </Button>
              </div>
            ) : gate ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge tone={gate.pass ? "success" : "error"} testId="integrations-gate-result-badge">{gate.pass ? L.gatePass : L.gateFail}</Badge>
                  {gate.coverage_pct !== undefined && (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {L.coverage} <Mono style={{ fontSize: 12, color: "var(--accent)" }}>{Math.round(gate.coverage_pct)}%</Mono>
                    </span>
                  )}
                  {gate.open_defects && (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      <Mono style={{ fontSize: 12, color: (gate.open_defects.critical ?? 0) > 0 ? "var(--error)" : "var(--success)" }}>
                        {gate.open_defects.critical ?? 0}
                      </Mono>{" "}
                      {L.criticalDefects}
                    </span>
                  )}
                  {gate.latest_run?.display_id !== undefined && (
                    <Mono style={{ fontSize: 11, color: "var(--text-muted)" }}>#{gate.latest_run.display_id}</Mono>
                  )}
                </div>
                {!gate.pass &&
                  (gate.breaches ?? []).map((b, i) => (
                    <div
                      key={i}
                      style={{
                        background: "var(--error-subtle)",
                        borderRadius: 10,
                        padding: "8px 12px",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <span>
                        <span style={{ color: "var(--error)", fontWeight: 600 }}>{L.breach}</span>{" "}
                        <Mono style={{ fontSize: 11.5 }}>{b.check}</Mono> — {L.limit}{" "}
                        <Mono style={{ fontSize: 11.5 }}>{String(b.limit)}</Mono> · {L.actual}{" "}
                        <Mono style={{ fontSize: 11.5, color: "var(--error)" }}>{String(b.actual)}</Mono>
                      </span>
                      {b.requirement_external_ids && b.requirement_external_ids.length > 0 && (
                        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {b.requirement_external_ids.map((r) => (
                            <Mono key={r} style={{ fontSize: 10.5, color: "var(--accent)" }}>
                              {r}
                            </Mono>
                          ))}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            ) : gateLoading ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{L.loading}</div>
            ) : null}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="code-block" dir="ltr" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {curl}
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <CopyButton text={curl} label={L.copy} copied={L.copied} />
                <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{L.curlHint}</span>
              </div>
            </div>
          </div>
        </Card>

        {/* ---------- Jira / Xray export ---------- */}
        <Card
          title={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {L.xrayTitle} <RefChip id="FR-070" />
            </span>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{L.xraySub}</div>
            {runsError ? (
              <div className="row" style={{ gap: 10 }}>
                <span className="error-text" style={{ fontSize: 13 }}>
                  {L.loadError} — {runsError}
                </span>
                <Button variant="secondary" size="sm" onClick={loadRuns}>
                  {L.retry}
                </Button>
              </div>
            ) : runs.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--warning)" }}>{L.noRuns}</div>
            ) : (
              <>
                <Field label={L.run}>
                  <Select testId="integrations-xray-run-select" value={runId} onChange={(e) => setRunId(e.target.value)}>
                    <option value="">{L.pickRun}</option>
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.display_id !== undefined ? `#${r.display_id}` : String(r.id).slice(0, 8)}
                        {r.state ? ` · ${r.state}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button variant="secondary" size="sm" testId="integrations-xray-download-button" disabled={!runId || dlBusy !== null} onClick={() => download("xray")}>
                    ⇩ {L.dlXray}
                  </Button>
                  <Button variant="secondary" size="sm" testId="integrations-defects-download-button" disabled={!runId || dlBusy !== null} onClick={() => download("defects")}>
                    ⇩ {L.dlDefects}
                  </Button>
                </div>
                {dlError && <div className="error-text" style={{ fontSize: 12.5 }}>{dlError}</div>}
              </>
            )}
          </div>
        </Card>

        {/* ---------- Coming soon ---------- */}
        <div style={{ display: "grid", gap: 16 }}>
          <Card
            title={
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center", color: "var(--text-muted)" }}>
                {L.confluenceTitle} <RefChip id="FR-011" />
              </span>
            }
            action={<Badge tone="muted">{L.soon}</Badge>}
            style={{ opacity: 0.65 }}
          >
            <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{L.confluenceSub}</div>
          </Card>
          <Card
            title={<span style={{ color: "var(--text-muted)" }}>{L.jiraSyncTitle}</span>}
            action={<Badge tone="muted">{L.soon}</Badge>}
            style={{ opacity: 0.65 }}
          >
            <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{L.jiraSyncSub}</div>
          </Card>
        </div>
      </div>

      {/* ---------- Webhook modal ---------- */}
      <Modal open={whModalOpen} onClose={() => setWhModalOpen(false)} title={whEditing ? L.editWh : L.newWh} testId="integrations-webhook-modal">
        <form onSubmit={saveWh} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.whName}>
            <Input
              required
              maxLength={100}
              testId="integrations-webhook-name-input"
              placeholder={ar ? "مثال: قناة الجودة في Slack" : "e.g. QA Slack channel"}
              value={whForm.name}
              onChange={(e) => setWhForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label={L.whUrl} hint={L.whSlackHint}>
            <Input
              required
              dir="ltr"
              testId="integrations-webhook-url-input"
              placeholder="https://hooks.slack.com/services/…"
              value={whForm.url}
              onChange={(e) => setWhForm((f) => ({ ...f, url: e.target.value }))}
            />
          </Field>
          <Field label={L.whSecret} hint={L.whSecretHint}>
            <Input
              dir="ltr"
              type="password"
              autoComplete="off"
              testId="integrations-webhook-secret-input"
              value={whForm.secret}
              onChange={(e) => setWhForm((f) => ({ ...f, secret: e.target.value }))}
            />
          </Field>
          <label
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" }}
          >
            <input
              type="checkbox"
              data-testid="integrations-webhook-enabled-checkbox"
              checked={whForm.enabled}
              onChange={(e) => setWhForm((f) => ({ ...f, enabled: e.target.checked }))}
              style={{ accentColor: "var(--accent)" }}
            />
            {L.enabled}
          </label>
          {whFormError && <div className="error-text" style={{ fontSize: 13 }}>{whFormError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="integrations-webhook-cancel-button" onClick={() => setWhModalOpen(false)}>
              {L.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              testId="integrations-webhook-submit-button"
              disabled={whBusy || !whForm.name.trim() || !whForm.url.trim()}
            >
              {whBusy ? L.saving : whEditing ? L.save : L.create}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ---------- Webhook delete confirm ---------- */}
      <Modal open={!!whDeleting} onClose={() => setWhDeleting(null)} title={L.delWhTitle} testId="integrations-webhook-delete-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{whDeleting?.name}</div>
            {L.delWhConfirm}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="integrations-webhook-delete-cancel-button" onClick={() => setWhDeleting(null)}>
              {L.cancel}
            </Button>
            <Button variant="danger" testId="integrations-webhook-delete-confirm-button" disabled={whDeleteBusy} onClick={deleteWh}>
              {L.confirm}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
