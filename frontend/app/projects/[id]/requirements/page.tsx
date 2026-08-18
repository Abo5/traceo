"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, pollJob } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Modal,
  PageHeader,
  Pill,
  Progress,
  Select,
  StatusDot,
  Textarea,
} from "@/components/ui";

type Tone = "success" | "warning" | "error" | "info" | "muted" | "accent";

const STATE_TONE: Record<string, Tone> = {
  draft: "muted",
  extracted: "info",
  confirmed: "success",
  changed: "warning",
  removed: "error",
  archived: "muted",
};

const PARSE_TONE: Record<string, Tone> = {
  queued: "info",
  running: "info",
  completed: "success",
  failed: "error",
  parsed: "success",
  errored: "warning",
};

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.requirements ?? x?.documents ?? [];
}

function jobPct(j: any): number {
  const p = Number(j?.progress ?? 0);
  if (!isFinite(p) || p <= 0) return 0;
  return Math.min(100, Math.round(p <= 1 ? p * 100 : p));
}

function M({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span
      style={{ fontFamily: "'JetBrains Mono',ui-monospace,monospace", fontSize: 12, ...style }}
    >
      {children}
    </span>
  );
}

export default function RequirementsPage() {
  const { id } = useParams<{ id: string }>();
  const canDo = useCan();

  const L = {
    title: "Requirements",
    sub: "Upload the requirements document to extract and confirm them",
    dropTitle: "Drop the requirements document here or click to browse",
    dropHint: "PDF · DOCX · MD · TXT — up to 50MB",
    parsing: "Parsing document and extracting requirements…",
    documents: "Documents",
    version: "Version",
    noDocs: "No documents yet",
    noDocsHint: "Upload a requirements document to get started",
    requirements: "Extracted requirements",
    all: "All",
    extracted: "Extracted",
    confirmed: "Confirmed",
    changed: "Changed",
    removed: "Removed",
    search: "Search requirements…",
    type: "Type",
    priority: "Priority",
    anyType: "All types",
    anyPriority: "All priorities",
    confidence: "Confidence",
    confirm: "Confirm",
    confirmAll: "Confirm all",
    edit: "Edit",
    empty: "No requirements",
    emptyHint: "Upload a requirements document to get started",
    emptyFiltered: "No results match the filters",
    emptyFilteredHint: "Try changing the filters or search",
    editTitle: "Edit requirement",
    externalId: "External ID",
    description: "Description",
    acceptance: "Acceptance criteria (one per line)",
    save: "Save",
    cancel: "Cancel",
    retry: "Retry",
    loadError: "Failed to load data",
    high: "High",
    medium: "Medium",
    low: "Low",
    criteria: "acceptance criteria",
    v: "v",
  };

  const stateLabel = (s: string) =>
    (({ extracted: L.extracted, confirmed: L.confirmed, changed: L.changed, removed: L.removed } as Record<string, string>)[s] ?? s);

  const [docs, setDocs] = useState<any[]>([]);
  const [reqs, setReqs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stateF, setStateF] = useState("all");
  const [typeF, setTypeF] = useState("");
  const [prioF, setPrioF] = useState("");
  const [q, setQ] = useState("");

  const [drag, setDrag] = useState(false);
  const [job, setJob] = useState<{ msg: string; pct: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState({ external_id: "", description: "", type: "", priority: "", acceptance: "" });
  const [saving, setSaving] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  async function loadDocs() {
    const d = await api(`/projects/${id}/documents`);
    setDocs(asList(d));
  }

  async function loadReqs() {
    const qs = new URLSearchParams();
    if (stateF !== "all") qs.set("state", stateF);
    if (typeF) qs.set("type", typeF);
    if (prioF) qs.set("priority", prioF);
    if (q.trim()) qs.set("q", q.trim());
    const r = await api(`/projects/${id}/requirements${qs.toString() ? `?${qs}` : ""}`);
    setReqs(asList(r));
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([api(`/projects/${id}/documents`), (async () => loadReqsRaw())()])
      .then(([d, r]) => {
        if (!alive) return;
        setDocs(asList(d));
        setReqs(asList(r));
      })
      .catch((e) => alive && setError(e?.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function loadReqsRaw() {
    const qs = new URLSearchParams();
    if (stateF !== "all") qs.set("state", stateF);
    if (typeF) qs.set("type", typeF);
    if (prioF) qs.set("priority", prioF);
    if (q.trim()) qs.set("q", q.trim());
    return api(`/projects/${id}/requirements${qs.toString() ? `?${qs}` : ""}`);
  }

  // refetch requirements when filters change (debounced for search)
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => {
      loadReqs().catch((e) => setError(e?.message || String(e)));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateF, typeF, prioF, q]);

  async function upload(file: File) {
    setUploadError(null);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await api(`/projects/${id}/documents`, { form: formData });
      setJob({ msg: L.parsing, pct: 2 });
      await pollJob(res.job_id, (j) => setJob({ msg: j?.message || L.parsing, pct: jobPct(j) }));
      setJob(null);
      await Promise.all([loadDocs(), loadReqs()]);
    } catch (e: any) {
      setJob(null);
      setUploadError(e?.message || String(e));
    }
  }

  async function confirmRow(r: any) {
    setBusyRow(r.id);
    try {
      await api(`/requirements/${r.id}`, { method: "PATCH", body: { state: "confirmed" } });
      setReqs((prev) => prev.map((x) => (x.id === r.id ? { ...x, state: "confirmed" } : x)));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyRow(null);
    }
  }

  async function confirmAll() {
    setConfirmingAll(true);
    try {
      await api(`/projects/${id}/requirements/confirm_all`, { method: "POST", body: {} });
      await loadReqs();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setConfirmingAll(false);
    }
  }

  function openEdit(r: any) {
    setEditing(r);
    setForm({
      external_id: r.external_id ?? "",
      description: r.description ?? "",
      type: r.type ?? "",
      priority: r.priority ?? "",
      acceptance: Array.isArray(r.acceptance_criteria) ? r.acceptance_criteria.join("\n") : "",
    });
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      const body: any = {
        external_id: form.external_id,
        description: form.description,
        type: form.type,
        priority: form.priority,
        acceptance_criteria: form.acceptance.split("\n").map((s) => s.trim()).filter(Boolean),
      };
      const updated = await api(`/requirements/${editing.id}`, { method: "PATCH", body });
      setReqs((prev) => prev.map((x) => (x.id === editing.id ? { ...x, ...body, ...(updated && updated.id ? updated : {}) } : x)));
      setEditing(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  const typeOptions = useMemo(() => {
    const s = new Set<string>();
    reqs.forEach((r) => r.type && s.add(r.type));
    if (typeF) s.add(typeF);
    return [...s];
  }, [reqs, typeF]);

  const prioOptions = useMemo(() => {
    const s = new Set<string>(["high", "medium", "low"]);
    reqs.forEach((r) => r.priority && s.add(r.priority));
    if (prioF) s.add(prioF);
    return [...s];
  }, [reqs, prioF]);

  const extractedCount = reqs.filter((r) => r.state === "extracted" || r.state === "changed").length;
  const hasFilters = stateF !== "all" || !!typeF || !!prioF || !!q.trim();

  return (
    <div data-testid="requirements-page-root" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={L.title}
        sub={L.sub}
        testId="requirements-page-header"
        actions={
          canDo("edit_requirements") && extractedCount > 0 ? (
            <Button variant="secondary" onClick={confirmAll} disabled={confirmingAll} testId="requirements-toolbar-confirm-all-button">
              {L.confirmAll} ({extractedCount})
            </Button>
          ) : undefined
        }
      />

      {/* Upload zone */}
      {canDo("upload_documents") && (
      <div
        data-testid="requirements-upload-dropzone"
        onClick={() => !job && fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !job) upload(f);
        }}
        style={{
          border: `1.5px dashed ${drag ? "var(--accent)" : "var(--border-strong)"}`,
          background: drag ? "var(--accent-subtle)" : "var(--surface)",
          borderRadius: 16,
          padding: "28px 24px",
          textAlign: "center",
          cursor: job ? "default" : "pointer",
          transition: "border-color 120ms, background 120ms",
        }}
      >
        <input
          ref={fileRef}
          data-testid="requirements-upload-file-input"
          type="file"
          accept=".pdf,.docx,.md,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = "";
          }}
        />
        {job ? (
          <div style={{ maxWidth: 480, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 14, color: "var(--text)" }}>{job.msg}</div>
            <Progress pct={job.pct} tone="accent" testId="requirements-upload-progress" />
            <M style={{ color: "var(--text-secondary)" }}>{job.pct}%</M>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{L.dropTitle}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>
              <M>{L.dropHint}</M>
            </div>
          </>
        )}
        {uploadError && (
          <div style={{ marginTop: 12, fontSize: 13, color: "var(--error)" }}>{uploadError}</div>
        )}
      </div>
      )}

      {/* Documents */}
      <Card title={L.documents} testId="requirements-documents-card">
        {docs.length === 0 ? (
          <Empty title={L.noDocs} hint={L.noDocsHint} testId="requirements-documents-empty-state" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {docs.map((d, i) => (
              <div
                key={d.id ?? i}
                data-testid="requirements-document-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 4px",
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                }}
              >
                <M style={{ color: "var(--text)" }}>{d.filename ?? d.name ?? d.id}</M>
                <Badge tone="muted">
                  {L.v}
                  {d.version ?? 1}
                </Badge>
                <div style={{ marginLeft: "auto" }}>
                  <Badge tone={PARSE_TONE[d.parse_status] ?? "muted"} testId="requirements-document-parse-status-badge" state={d.parse_status}>{d.parse_status ?? "—"}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Requirements */}
      <Card
        title={L.requirements}
        testId="requirements-list-card"
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Input placeholder={L.search} value={q} onChange={(e: any) => setQ(e.target.value)} testId="requirements-search-input" />
            <Select value={typeF} onChange={(e: any) => setTypeF(e.target.value)} testId="requirements-type-select" aria-label="filter by type">
              <option value="">{L.anyType}</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Select value={prioF} onChange={(e: any) => setPrioF(e.target.value)} testId="requirements-priority-select" aria-label="filter by priority">
              <option value="">{L.anyPriority}</option>
              {prioOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {[
            ["all", L.all],
            ["extracted", L.extracted],
            ["confirmed", L.confirmed],
            ["changed", L.changed],
            ["removed", L.removed],
          ].map(([v, label]) => (
            <Pill
              key={v}
              active={stateF === v}
              onClick={() => setStateF(v)}
              testId={`requirements-filter-${v}-pill`}
              state={v === "all" ? undefined : v}
            >
              {label}
            </Pill>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 24, color: "var(--text-secondary)", fontSize: 13 }}>…</div>
        ) : error ? (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <div style={{ color: "var(--error)", fontSize: 13 }}>
              {L.loadError} — {error}
            </div>
            <Button
              variant="secondary"
              size="sm"
              testId="requirements-list-retry-button"
              onClick={() => {
                setError(null);
                loadReqs().catch((e) => setError(e?.message || String(e)));
              }}
            >
              {L.retry}
            </Button>
          </div>
        ) : reqs.length === 0 ? (
          <Empty
            title={hasFilters ? L.emptyFiltered : L.empty}
            hint={hasFilters ? L.emptyFilteredHint : L.emptyHint}
            testId="requirements-empty-state"
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {reqs.map((r, i) => {
              const conf = Math.round((Number(r.confidence) || 0) * 100);
              const confTone = conf >= 75 ? "success" : conf >= 50 ? "warning" : "error";
              return (
                <div
                  key={r.id ?? i}
                  data-testid="requirements-row"
                  data-state={r.state}
                  style={{
                    display: "flex",
                    gap: 16,
                    alignItems: "flex-start",
                    padding: "14px 4px",
                    borderTop: i === 0 ? "none" : "1px solid var(--border)",
                    opacity: r.state === "removed" ? 0.55 : 1,
                  }}
                >
                  <M style={{ color: "var(--accent)", fontWeight: 500, minWidth: 90, paddingTop: 2 }}>
                    {r.external_id ?? "—"}
                  </M>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}>{r.description}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <StatusDot state={r.state} testId="requirements-row-status-dot" />
                        <Badge tone={STATE_TONE[r.state] ?? "muted"} testId="requirements-row-state-badge" state={r.state}>{stateLabel(r.state)}</Badge>
                      </span>
                      {r.type && <Badge tone="info">{r.type}</Badge>}
                      {r.priority && (
                        <Badge tone={r.priority === "high" ? "error" : r.priority === "medium" ? "warning" : "muted"}>
                          {r.priority}
                        </Badge>
                      )}
                      {Array.isArray(r.acceptance_criteria) && r.acceptance_criteria.length > 0 && (
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                          {r.acceptance_criteria.length} {L.criteria}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ width: 130, flexShrink: 0 }}>
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--text-secondary)",
                        marginBottom: 6,
                      }}
                    >
                      {L.confidence} <M style={{ fontSize: 11 }}>{conf}%</M>
                    </div>
                    <Progress pct={conf} tone={confTone} testId="requirements-row-confidence-progress" />
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {canDo("edit_requirements") && (
                      <Button variant="ghost" size="sm" onClick={() => openEdit(r)} testId="requirements-row-edit-button">
                        {L.edit}
                      </Button>
                    )}
                    {canDo("edit_requirements") && r.state !== "confirmed" && r.state !== "removed" && (
                      <Button variant="secondary" size="sm" disabled={busyRow === r.id} onClick={() => confirmRow(r)} testId="requirements-row-confirm-button">
                        {L.confirm}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Edit modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={L.editTitle} testId="requirements-edit-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.externalId} testId="requirements-edit-external-id-input">
            <Input
              value={form.external_id}
              onChange={(e: any) => setForm((f) => ({ ...f, external_id: e.target.value }))}
            />
          </Field>
          <Field label={L.description} testId="requirements-edit-description-textarea">
            <Textarea
              rows={4}
              value={form.description}
              onChange={(e: any) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </Field>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Field label={L.type} testId="requirements-edit-type-input">
                <Input value={form.type} onChange={(e: any) => setForm((f) => ({ ...f, type: e.target.value }))} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label={L.priority} testId="requirements-edit-priority-select">
                <Select value={form.priority} onChange={(e: any) => setForm((f) => ({ ...f, priority: e.target.value }))}>
                  {!["high", "medium", "low", ""].includes(form.priority) && (
                    <option value={form.priority}>{form.priority}</option>
                  )}
                  <option value="high">{L.high}</option>
                  <option value="medium">{L.medium}</option>
                  <option value="low">{L.low}</option>
                </Select>
              </Field>
            </div>
          </div>
          <Field label={L.acceptance} testId="requirements-edit-acceptance-textarea">
            <Textarea
              rows={5}
              value={form.acceptance}
              onChange={(e: any) => setForm((f) => ({ ...f, acceptance: e.target.value }))}
            />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setEditing(null)} testId="requirements-edit-cancel-button">
              {L.cancel}
            </Button>
            <Button variant="primary" disabled={saving} onClick={saveEdit} testId="requirements-edit-save-button">
              {L.save}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
