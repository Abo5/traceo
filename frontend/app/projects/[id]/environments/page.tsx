"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18n";
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
  Textarea,
} from "@/components/ui";

type Env = {
  id: string;
  name: string;
  base_url: string;
  auth_type: string;
  variables: Record<string, string>;
  tls_strict: boolean;
  auth_config_masked: boolean;
};

type CheckResult = { reachable: boolean; status_code?: number; auth_applied?: boolean; error?: string };

const AUTH_TYPES = ["none", "api_key", "basic", "bearer", "oauth2_cc"] as const;

const EMPTY_FORM = {
  name: "",
  base_url: "",
  auth_type: "none",
  tls_strict: true,
  variablesText: "",
  // secret inputs (write-only; only sent when filled)
  key: "",
  header: "",
  username: "",
  password: "",
  token: "",
  token_url: "",
  client_id: "",
  client_secret: "",
};

function varsToText(vars: Record<string, string> | undefined): string {
  if (!vars) return "";
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function textToVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

export default function EnvironmentsPage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useLang();
  const ar = lang === "ar";

  const L = ar
    ? {
        title: "البيئات",
        sub: "بيئات التنفيذ التي تُشغَّل عليها حالات الاختبار",
        newEnv: "بيئة جديدة",
        editEnv: "تعديل البيئة",
        name: "اسم البيئة",
        baseUrl: "الرابط الأساسي",
        authType: "نوع المصادقة",
        authNames: {
          none: "بدون",
          api_key: "مفتاح API",
          basic: "أساسية (Basic)",
          bearer: "رمز Bearer",
          oauth2_cc: "OAuth2 Client Credentials",
        } as Record<string, string>,
        headerName: "اسم الترويسة",
        keyValue: "قيمة المفتاح",
        username: "اسم المستخدم",
        password: "كلمة المرور",
        token: "الرمز",
        tokenUrl: "رابط الرمز",
        clientId: "معرّف العميل",
        clientSecret: "سر العميل",
        secretHint: "تُحفظ الأسرار مشفّرة ولا تُعرض بعد الحفظ — اتركها فارغة للإبقاء على السر الحالي",
        secretSaved: "سر محفوظ",
        variables: "المتغيرات",
        variablesHint: "سطر لكل متغيّر بصيغة KEY=VALUE — تُستخدم في الاستيفاء {{var}}",
        tls: "التحقق من شهادة TLS",
        save: "حفظ",
        cancel: "إلغاء",
        create: "إنشاء",
        edit: "تعديل",
        del: "حذف",
        check: "فحص الاتصال",
        checking: "جارٍ الفحص…",
        reachable: "قابل للوصول",
        unreachable: "غير قابل للوصول",
        authApplied: "مصادقة مفعّلة",
        empty: "لا توجد بيئات بعد",
        emptyHint: "أنشئ بيئة (مثل Staging) لتشغيل الاختبارات عليها",
        confirmDeleteTitle: "حذف البيئة",
        confirmDelete: "سيتم حذف هذه البيئة نهائيًا. متابعة؟",
        confirm: "تأكيد",
        loading: "جارٍ التحميل…",
      }
    : {
        title: "Environments",
        sub: "Execution environments your test cases run against",
        newEnv: "New environment",
        editEnv: "Edit environment",
        name: "Environment name",
        baseUrl: "Base URL",
        authType: "Auth type",
        authNames: {
          none: "None",
          api_key: "API key",
          basic: "Basic",
          bearer: "Bearer token",
          oauth2_cc: "OAuth2 Client Credentials",
        } as Record<string, string>,
        headerName: "Header name",
        keyValue: "Key value",
        username: "Username",
        password: "Password",
        token: "Token",
        tokenUrl: "Token URL",
        clientId: "Client ID",
        clientSecret: "Client secret",
        secretHint:
          "Secrets are stored encrypted and never shown after saving — leave blank to keep the current secret",
        secretSaved: "Secret saved",
        variables: "Variables",
        variablesHint: "One per line as KEY=VALUE — used for {{var}} interpolation",
        tls: "Verify TLS certificate",
        save: "Save",
        cancel: "Cancel",
        create: "Create",
        edit: "Edit",
        del: "Delete",
        check: "Check connectivity",
        checking: "Checking…",
        reachable: "Reachable",
        unreachable: "Unreachable",
        authApplied: "Auth applied",
        empty: "No environments yet",
        emptyHint: "Create an environment (e.g. Staging) to run tests against",
        confirmDeleteTitle: "Delete environment",
        confirmDelete: "This environment will be permanently deleted. Continue?",
        confirm: "Confirm",
        loading: "Loading…",
      };

  const [envs, setEnvs] = useState<Env[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Env | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<Env | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});

  async function load() {
    try {
      const list = await api<Env[]>(`/projects/${id}/environments`);
      setEnvs(Array.isArray(list) ? list : (list as any)?.items ?? []);
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
  }, [id]);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(env: Env) {
    setEditing(env);
    setForm({
      ...EMPTY_FORM,
      name: env.name,
      base_url: env.base_url,
      auth_type: env.auth_type,
      tls_strict: env.tls_strict,
      variablesText: varsToText(env.variables),
    });
    setFormError(null);
    setModalOpen(true);
  }

  function buildAuthConfig(): Record<string, string> | undefined {
    const t = form.auth_type;
    let cfg: Record<string, string> = {};
    if (t === "api_key") {
      if (form.key) cfg = { key: form.key, ...(form.header ? { header: form.header } : {}) };
    } else if (t === "basic") {
      if (form.username || form.password)
        cfg = { username: form.username, password: form.password };
    } else if (t === "bearer") {
      if (form.token) cfg = { token: form.token };
    } else if (t === "oauth2_cc") {
      if (form.client_id || form.client_secret || form.token_url)
        cfg = {
          client_id: form.client_id,
          client_secret: form.client_secret,
          token_url: form.token_url,
        };
    }
    return Object.keys(cfg).length ? cfg : undefined;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const authConfig = buildAuthConfig();
    const body: any = {
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      auth_type: form.auth_type,
      variables: textToVars(form.variablesText),
      tls_strict: form.tls_strict,
    };
    // write-only secrets: only send when the user typed something new
    if (authConfig !== undefined) body.auth_config = authConfig;
    try {
      if (editing) {
        await api(`/projects/${id}/environments/${editing.id}`, {
          method: "PATCH",
          body,
        });
      } else {
        await api(`/projects/${id}/environments`, { body });
      }
      setModalOpen(false);
      await load();
    } catch (err: any) {
      setFormError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  async function check(env: Env) {
    setChecking(env.id);
    try {
      const res = await api<CheckResult>(`/projects/${id}/environments/${env.id}/check`, {
        method: "POST",
        body: {},
      });
      setChecks((c) => ({ ...c, [env.id]: res }));
    } catch (e: any) {
      setChecks((c) => ({ ...c, [env.id]: { reachable: false, error: e?.message || String(e) } }));
    } finally {
      setChecking(null);
    }
  }

  async function runDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api(`/projects/${id}/environments/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  const secretInputs = () => {
    switch (form.auth_type) {
      case "api_key":
        return (
          <>
            <Field label={L.headerName}>
              <Input
                dir="ltr"
                placeholder="X-API-Key"
                value={form.header}
                onChange={(e) => setForm((f) => ({ ...f, header: e.target.value }))}
              />
            </Field>
            <Field label={L.keyValue} hint={L.secretHint}>
              <Input
                dir="ltr"
                type="password"
                autoComplete="off"
                value={form.key}
                onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              />
            </Field>
          </>
        );
      case "basic":
        return (
          <>
            <Field label={L.username}>
              <Input
                dir="ltr"
                autoComplete="off"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              />
            </Field>
            <Field label={L.password} hint={L.secretHint}>
              <Input
                dir="ltr"
                type="password"
                autoComplete="off"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />
            </Field>
          </>
        );
      case "bearer":
        return (
          <Field label={L.token} hint={L.secretHint}>
            <Input
              dir="ltr"
              type="password"
              autoComplete="off"
              value={form.token}
              onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
            />
          </Field>
        );
      case "oauth2_cc":
        return (
          <>
            <Field label={L.tokenUrl}>
              <Input
                dir="ltr"
                placeholder="https://auth.example.com/oauth/token"
                value={form.token_url}
                onChange={(e) => setForm((f) => ({ ...f, token_url: e.target.value }))}
              />
            </Field>
            <Field label={L.clientId}>
              <Input
                dir="ltr"
                autoComplete="off"
                value={form.client_id}
                onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value }))}
              />
            </Field>
            <Field label={L.clientSecret} hint={L.secretHint}>
              <Input
                dir="ltr"
                type="password"
                autoComplete="off"
                value={form.client_secret}
                onChange={(e) => setForm((f) => ({ ...f, client_secret: e.target.value }))}
              />
            </Field>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className="stack">
      <PageHeader
        title={L.title}
        sub={L.sub}
        actions={
          <Button variant="primary" onClick={openCreate}>
            + {L.newEnv}
          </Button>
        }
      />

      {error && <div className="error-text">{error}</div>}

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{L.loading}</div>
      ) : envs.length === 0 ? (
        <Empty title={L.empty} hint={L.emptyHint} />
      ) : (
        <div className="grid-cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {envs.map((env) => {
            const res = checks[env.id];
            return (
              <div
                key={env.id}
                className="card"
                style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0 }}>
                    {env.name}
                  </div>
                  <Badge tone="info">{L.authNames[env.auth_type] ?? env.auth_type}</Badge>
                </div>

                <Mono
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    overflowWrap: "anywhere",
                    display: "block",
                  }}
                >
                  {env.base_url}
                </Mono>

                <div className="row" style={{ gap: 6 }}>
                  {env.auth_config_masked && <Badge tone="accent">🔒 {L.secretSaved}</Badge>}
                  {!env.tls_strict && <Badge tone="warning">TLS ✕</Badge>}
                  {Object.keys(env.variables ?? {}).length > 0 && (
                    <Badge tone="muted">
                      {Object.keys(env.variables).length} {L.variables}
                    </Badge>
                  )}
                </div>

                {res && (
                  <div className="row" style={{ gap: 8 }}>
                    <Badge tone={res.reachable ? "success" : "error"}>
                      {res.reachable ? L.reachable : L.unreachable}
                      {res.status_code !== undefined ? ` · ${res.status_code}` : ""}
                    </Badge>
                    {res.reachable && res.auth_applied && (
                      <Badge tone="info">{L.authApplied}</Badge>
                    )}
                    {!res.reachable && res.error && (
                      <span
                        className="error-text"
                        style={{ fontSize: 11.5, overflowWrap: "anywhere" }}
                      >
                        {res.error}
                      </span>
                    )}
                  </div>
                )}

                <div className="row" style={{ marginTop: "auto" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={checking === env.id}
                    onClick={() => check(env)}
                  >
                    {checking === env.id ? L.checking : L.check}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(env)}>
                    {L.edit}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setDeleting(env)}>
                    {L.del}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* create / edit modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? L.editEnv : L.newEnv}
      >
        <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.name}>
            <Input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label={L.baseUrl}>
            <Input
              required
              dir="ltr"
              placeholder="https://staging.example.com"
              value={form.base_url}
              onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
            />
          </Field>
          <Field label={L.authType}>
            <Select
              value={form.auth_type}
              onChange={(e) => setForm((f) => ({ ...f, auth_type: e.target.value }))}
            >
              {AUTH_TYPES.map((t) => (
                <option key={t} value={t}>
                  {L.authNames[t]}
                </option>
              ))}
            </Select>
          </Field>

          {editing?.auth_config_masked && form.auth_type !== "none" && (
            <div className="row" style={{ gap: 8 }}>
              <Badge tone="accent">🔒 {L.secretSaved}</Badge>
            </div>
          )}

          {secretInputs()}

          <Field label={L.variables} hint={L.variablesHint}>
            <Textarea
              dir="ltr"
              rows={3}
              placeholder={"admin_token=...\nuser_id=42"}
              value={form.variablesText}
              onChange={(e) => setForm((f) => ({ ...f, variablesText: e.target.value }))}
            />
          </Field>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={form.tls_strict}
              onChange={(e) => setForm((f) => ({ ...f, tls_strict: e.target.checked }))}
            />
            {L.tls}
          </label>

          {formError && <div className="error-text">{formError}</div>}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              {L.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={saving || !form.name.trim() || !form.base_url.trim()}
            >
              {editing ? L.save : L.create}
            </Button>
          </div>
        </form>
      </Modal>

      {/* delete confirm */}
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={L.confirmDeleteTitle}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
            <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
              {deleting?.name}
            </div>
            {L.confirmDelete}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {L.cancel}
            </Button>
            <Button variant="danger" disabled={deleteBusy} onClick={runDelete}>
              {L.confirm}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
