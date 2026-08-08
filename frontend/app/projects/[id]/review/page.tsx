"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18n";
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
  RefChip,
  Select,
  StatusDot,
  Textarea,
} from "@/components/ui";

type Tone = "success" | "warning" | "error" | "info" | "muted" | "accent";

const STATE_TONE: Record<string, Tone> = {
  draft: "muted",
  approved: "success",
  rejected: "error",
  stale: "warning",
  archived: "muted",
};

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.test_cases ?? x?.cases ?? [];
}

function M({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span dir="ltr" style={{ fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace", fontSize: 12, ...style }}>
      {children}
    </span>
  );
}

function JsonBlock({ value }: { value: any }) {
  return (
    <pre
      dir="ltr"
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "10px 12px",
        margin: 0,
        fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace",
        fontSize: 11.5,
        lineHeight: 1.6,
        color: "var(--text-secondary)",
        overflowX: "auto",
        whiteSpace: "pre",
        textAlign: "left",
      }}
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function caseReqs(c: any): any[] {
  return c?.requirements ?? c?.requirement_links ?? c?.linked_requirements ?? [];
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useLang();
  const canDo = useCan();

  const L =
    lang === "ar"
      ? {
          title: "المراجعة",
          sub: "راجع الحالات المولّدة — اعتمد أو ارفض أو عدّل قبل التنفيذ",
          all: "الكل",
          draft: "مسودة",
          approved: "معتمد",
          rejected: "مرفوض",
          stale: "قديم",
          search: "بحث في الحالات…",
          queue: "قائمة الحالات",
          empty: "لا توجد حالات",
          emptyHint: "ولّد حالات اختبار من صفحة التوليد أولاً",
          emptyFiltered: "لا نتائج مطابقة للمرشّحات",
          emptyFilteredHint: "جرّب تغيير المرشّح أو البحث",
          pickCase: "اختر حالة من القائمة",
          pickCaseHint: "التفاصيل الكاملة والإجراءات تظهر هنا",
          linkedReq: "المتطلب المرتبط",
          technique: "الأسلوب",
          priority: "الأولوية",
          model: "النموذج",
          promptV: "إصدار الموجّه",
          preconditions: "الشروط المسبقة",
          steps: "الخطوات",
          request: "الطلب",
          assertions: "التحقّقات",
          extractions: "الاستخلاصات",
          approve: "اعتماد",
          reject: "رفض",
          edit: "تعديل",
          rejectTitle: "رفض الحالة",
          reason: "سبب الرفض",
          rIncorrect: "غير صحيحة",
          rShallow: "سطحية",
          rDuplicate: "مكرّرة",
          rOther: "أخرى",
          reasonText: "تفاصيل إضافية",
          confirmReject: "تأكيد الرفض",
          editTitle: "تعديل الحالة",
          caseTitle: "العنوان",
          description: "الوصف",
          stepsJson: "الخطوات (JSON)",
          assertionsJson: "التحقّقات (JSON)",
          jsonInvalid: "JSON غير صالح",
          save: "حفظ",
          cancel: "إلغاء",
          bulkSelected: "حالة محددة",
          approveAll: "اعتماد الكل",
          rejectAll: "رفض الكل",
          clear: "إلغاء التحديد",
          kbd: "a اعتماد · r رفض · j/k تنقّل",
          loadError: "تعذّر تحميل البيانات",
          retry: "إعادة المحاولة",
          expected: "المتوقع",
          high: "عالية",
          medium: "متوسطة",
          low: "منخفضة",
        }
      : {
          title: "Review",
          sub: "Review generated cases — approve, reject or edit before execution",
          all: "All",
          draft: "Draft",
          approved: "Approved",
          rejected: "Rejected",
          stale: "Stale",
          search: "Search cases…",
          queue: "Case queue",
          empty: "No test cases",
          emptyHint: "Generate test cases from the Generate page first",
          emptyFiltered: "No results match the filters",
          emptyFilteredHint: "Try changing the filter or search",
          pickCase: "Pick a case from the list",
          pickCaseHint: "Full details and actions appear here",
          linkedReq: "Linked requirement",
          technique: "Technique",
          priority: "Priority",
          model: "Model",
          promptV: "Prompt version",
          preconditions: "Preconditions",
          steps: "Steps",
          request: "Request",
          assertions: "Assertions",
          extractions: "Extractions",
          approve: "Approve",
          reject: "Reject",
          edit: "Edit",
          rejectTitle: "Reject case",
          reason: "Rejection reason",
          rIncorrect: "Incorrect",
          rShallow: "Shallow",
          rDuplicate: "Duplicate",
          rOther: "Other",
          reasonText: "Additional details",
          confirmReject: "Confirm rejection",
          editTitle: "Edit case",
          caseTitle: "Title",
          description: "Description",
          stepsJson: "Steps (JSON)",
          assertionsJson: "Assertions (JSON)",
          jsonInvalid: "Invalid JSON",
          save: "Save",
          cancel: "Cancel",
          bulkSelected: "selected",
          approveAll: "Approve all",
          rejectAll: "Reject all",
          clear: "Clear selection",
          kbd: "a approve · r reject · j/k navigate",
          loadError: "Failed to load data",
          retry: "Retry",
          expected: "Expected",
          high: "High",
          medium: "Medium",
          low: "Low",
        };

  const stateLabel = (s: string) =>
    (({ draft: L.draft, approved: L.approved, rejected: L.rejected, stale: L.stale } as Record<string, string>)[s] ?? s);

  const [cases, setCases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stateF, setStateF] = useState("all");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectCode, setRejectCode] = useState("incorrect");
  const [rejectText, setRejectText] = useState("");

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ title: "", description: "", priority: "", steps: "", assertions: "" });
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function fetchList() {
    const qs = new URLSearchParams();
    if (stateF !== "all") qs.set("state", stateF);
    if (q.trim()) qs.set("q", q.trim());
    return api(`/projects/${id}/test-cases${qs.toString() ? `?${qs}` : ""}`);
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchList()
      .then((r) => {
        if (!alive) return;
        const list = asList(r);
        setCases(list);
        const pre =
          typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("case") : null;
        const first = (pre && list.find((c: any) => c.id === pre)) || list[0];
        if (first) selectCase(first.id);
      })
      .catch((e) => alive && setError(e?.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => {
      fetchList()
        .then((r) => {
          const list = asList(r);
          setCases(list);
          setChecked(new Set());
          if (!list.some((c: any) => c.id === selectedIdRef.current)) {
            if (list[0]) selectCase(list[0].id);
            else {
              setSelectedId(null);
              setDetail(null);
            }
          }
        })
        .catch((e) => setError(e?.message || String(e)));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateF, q]);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  async function selectCase(cid: string) {
    setSelectedId(cid);
    setDetailLoading(true);
    try {
      const d = await api(`/test-cases/${cid}`);
      setDetail(d);
    } catch (e: any) {
      setDetail(null);
      setError(e?.message || String(e));
    } finally {
      setDetailLoading(false);
    }
  }

  function advanceFrom(cid: string, list: any[]) {
    const idx = list.findIndex((c) => c.id === cid);
    const next = list[idx + 1] ?? list[idx - 1] ?? null;
    if (next && next.id !== cid) selectCase(next.id);
  }

  async function approveCase(cid: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/test-cases/${cid}/approve`, { method: "POST", body: {} });
      setCases((prev) => {
        const updated = prev.map((c) => (c.id === cid ? { ...c, state: "approved" } : c));
        advanceFrom(cid, updated);
        return updated;
      });
      setDetail((d: any) => (d && d.id === cid ? { ...d, state: "approved" } : d));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rejectCase(cid: string, code: string, text: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/test-cases/${cid}/reject`, {
        method: "POST",
        body: { reason_code: code, reason_text: text },
      });
      setRejectOpen(false);
      setRejectText("");
      setCases((prev) => {
        const updated = prev.map((c) => (c.id === cid ? { ...c, state: "rejected" } : c));
        advanceFrom(cid, updated);
        return updated;
      });
      setDetail((d: any) => (d && d.id === cid ? { ...d, state: "rejected" } : d));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function bulk(action: "approve" | "reject") {
    if (checked.size === 0 || busy) return;
    setBusy(true);
    try {
      await api(`/test-cases/bulk`, {
        method: "POST",
        body: { ids: [...checked], action, ...(action === "reject" ? { reason_code: "other" } : {}) },
      });
      const newState = action === "approve" ? "approved" : "rejected";
      setCases((prev) => prev.map((c) => (checked.has(c.id) ? { ...c, state: newState } : c)));
      setDetail((d: any) => (d && checked.has(d.id) ? { ...d, state: newState } : d));
      setChecked(new Set());
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function openEdit() {
    if (!detail) return;
    setJsonError(null);
    setEditForm({
      title: detail.title ?? "",
      description: detail.description ?? "",
      priority: detail.priority ?? "",
      steps: JSON.stringify(detail.steps ?? [], null, 2),
      assertions: JSON.stringify(detail.assertions ?? [], null, 2),
    });
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!detail) return;
    setJsonError(null);
    let steps: any;
    let assertions: any;
    try {
      steps = JSON.parse(editForm.steps);
    } catch {
      setJsonError(`${L.jsonInvalid} — ${L.stepsJson}`);
      return;
    }
    try {
      assertions = JSON.parse(editForm.assertions);
    } catch {
      setJsonError(`${L.jsonInvalid} — ${L.assertionsJson}`);
      return;
    }
    setSaving(true);
    try {
      const body: any = {
        title: editForm.title,
        description: editForm.description,
        priority: editForm.priority,
        steps,
        assertions,
      };
      const updated = await api(`/test-cases/${detail.id}`, { method: "PATCH", body });
      const merged = { ...detail, ...body, ...(updated && updated.id ? updated : {}) };
      setDetail(merged);
      setCases((prev) => prev.map((c) => (c.id === detail.id ? { ...c, title: merged.title, state: merged.state ?? c.state } : c)));
      setEditOpen(false);
    } catch (e: any) {
      setJsonError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  // ---- keyboard shortcuts: a approve, r reject, j/k next/prev ----
  const actionsRef = useRef<any>({});
  actionsRef.current = {
    move(delta: number) {
      const cid = selectedIdRef.current;
      const idx = cases.findIndex((c) => c.id === cid);
      const next = cases[idx + delta];
      if (next) selectCase(next.id);
      else if (idx === -1 && cases[0]) selectCase(cases[0].id);
    },
    approve() {
      const cid = selectedIdRef.current;
      if (cid && canDo("approve_reject")) approveCase(cid);
    },
    openReject() {
      if (selectedIdRef.current && canDo("approve_reject")) setRejectOpen(true);
    },
    modalOpen: rejectOpen || editOpen,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      )
        return;
      const a = actionsRef.current;
      if (a.modalOpen) return;
      if (e.key === "j") a.move(1);
      else if (e.key === "k") a.move(-1);
      else if (e.key === "a") a.approve();
      else if (e.key === "r") a.openReject();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hasFilters = stateF !== "all" || !!q.trim();
  const detailReqs = useMemo(() => (detail ? caseReqs(detail) : []), [detail]);
  const steps: any[] = Array.isArray(detail?.steps) ? detail.steps : [];

  return (
    <div data-testid="review-page-root" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        testId="review-page-header"
        title={L.title}
        sub={
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {L.sub} <RefChip id="FR-035" /> <RefChip id="FR-036" />
          </span>
        }
        actions={<M style={{ color: "var(--text-muted)", fontSize: 11 }}>{L.kbd}</M>}
      />

      {error && (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ color: "var(--error)", fontSize: 13 }}>
            {L.loadError} — {error}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setError(null)} testId="review-error-retry-button">
            {L.retry}
          </Button>
        </div>
      )}

      {/* bulk bar */}
      {canDo("approve_reject") && checked.size > 0 && (
        <div
          data-testid="review-bulk-bar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 16px",
            borderRadius: 12,
            border: "1px solid var(--accent)",
            background: "var(--accent-subtle)",
          }}
        >
          <M style={{ color: "var(--accent)", fontWeight: 700 }}>{checked.size}</M>
          <span style={{ fontSize: 13, color: "var(--text)" }}>{L.bulkSelected}</span>
          <div style={{ marginInlineStart: "auto", display: "flex", gap: 8 }}>
            <Button size="sm" disabled={busy} onClick={() => bulk("approve")} testId="review-bulk-approve-button">
              {L.approveAll}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => bulk("reject")} testId="review-bulk-reject-button">
              {L.rejectAll}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())} testId="review-bulk-clear-button">
              {L.clear}
            </Button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        {/* Queue list — first in DOM = right side in RTL */}
        <div style={{ width: 380, flexShrink: 0 }}>
          <Card title={L.queue} pad={false} testId="review-queue-card">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  ["all", L.all],
                  ["draft", L.draft],
                  ["approved", L.approved],
                  ["rejected", L.rejected],
                  ["stale", L.stale],
                ].map(([v, label]) => (
                  <Pill
                    key={v}
                    active={stateF === v}
                    onClick={() => setStateF(v)}
                    testId={`review-filter-${v}-pill`}
                    state={v === "all" ? undefined : v}
                  >
                    {label}
                  </Pill>
                ))}
              </div>
              <Input placeholder={L.search} value={q} onChange={(e: any) => setQ(e.target.value)} testId="review-search-input" />
            </div>

            {loading ? (
              <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>…</div>
            ) : cases.length === 0 ? (
              <Empty
                title={hasFilters ? L.emptyFiltered : L.empty}
                hint={hasFilters ? L.emptyFilteredHint : L.emptyHint}
                testId="review-empty-state"
              />
            ) : (
              <div style={{ maxHeight: "62vh", overflowY: "auto" }}>
                {cases.map((c, i) => {
                  const reqs = caseReqs(c);
                  const sel = c.id === selectedId;
                  return (
                    <div
                      key={c.id ?? i}
                      data-testid="review-case-row"
                      data-state={c.state}
                      onClick={() => selectCase(c.id)}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "flex-start",
                        padding: "12px 14px",
                        cursor: "pointer",
                        borderTop: i === 0 ? "none" : "1px solid var(--border)",
                        background: sel ? "var(--accent-subtle)" : "transparent",
                        borderInlineStart: sel ? "3px solid var(--accent)" : "3px solid transparent",
                      }}
                    >
                      {canDo("approve_reject") && (
                      <input
                        type="checkbox"
                        data-testid="review-case-checkbox"
                        checked={checked.has(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() =>
                          setChecked((prev) => {
                            const n = new Set(prev);
                            if (n.has(c.id)) n.delete(c.id);
                            else n.add(c.id);
                            return n;
                          })
                        }
                        style={{ marginTop: 4, accentColor: "var(--accent)" }}
                      />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <StatusDot state={c.state} testId="review-case-status-dot" />
                          <div
                            style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1, minWidth: 0 }}
                            title={c.title}
                          >
                            <span
                              dir="auto"
                              style={{
                                display: "block",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {c.title}
                            </span>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
                          {c.technique && <Badge tone="info">{c.technique}</Badge>}
                          <Badge tone={STATE_TONE[c.state] ?? "muted"} testId="review-case-state-badge" state={c.state}>{stateLabel(c.state)}</Badge>
                          {reqs.slice(0, 2).map((r: any, j: number) => (
                            <M key={j} style={{ fontSize: 10, color: "var(--accent)" }}>
                              {r.external_id ?? r.id}
                            </M>
                          ))}
                          {reqs.length > 2 && (
                            <M style={{ fontSize: 10, color: "var(--text-muted)" }}>+{reqs.length - 2}</M>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Detail pane */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!selectedId || (!detail && !detailLoading) ? (
            <Card>
              <Empty title={L.pickCase} hint={L.pickCaseHint} />
            </Card>
          ) : detailLoading && !detail ? (
            <Card>
              <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>…</div>
            </Card>
          ) : (
            <Card
              testId="review-detail-card"
              title={
                <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
                  <StatusDot state={detail.state} testId="review-detail-status-dot" />
                  {detail.title}
                </span>
              }
              action={
                <div style={{ display: "flex", gap: 8 }}>
                  {canDo("edit_test_case") && (
                    <Button variant="ghost" size="sm" onClick={openEdit} testId="review-case-edit-button">
                      {L.edit}
                    </Button>
                  )}
                  {canDo("approve_reject") && (
                    <Button variant="danger" size="sm" disabled={busy} onClick={() => setRejectOpen(true)} testId="review-case-reject-button">
                      {L.reject}
                    </Button>
                  )}
                  {canDo("approve_reject") && (
                    <Button variant="primary" size="sm" disabled={busy || detail.state === "approved"} onClick={() => approveCase(detail.id)} testId="review-case-approve-button">
                      {L.approve}
                    </Button>
                  )}
                </div>
              }
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 16, opacity: detailLoading ? 0.6 : 1 }}>
                {/* Linked requirement panel */}
                {detailReqs.length > 0 && (
                  <div
                    style={{
                      borderInlineStart: "3px solid var(--accent)",
                      background: "var(--surface-2)",
                      borderRadius: 10,
                      padding: "12px 16px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--text-muted)",
                      }}
                    >
                      {L.linkedReq}
                    </div>
                    {detailReqs.map((r: any, i: number) => (
                      <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                        <M style={{ color: "var(--accent)", fontWeight: 500 }}>{r.external_id ?? r.id}</M>
                        <span style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>{r.description}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Meta */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {detail.technique && (
                    <Badge tone="info">
                      {L.technique}: <M style={{ fontSize: 11 }}>{detail.technique}</M>
                    </Badge>
                  )}
                  {detail.priority && (
                    <Badge tone={detail.priority === "high" ? "error" : detail.priority === "medium" ? "warning" : "muted"}>
                      {L.priority}: {detail.priority}
                    </Badge>
                  )}
                  {detail.model && (
                    <Badge tone="muted">
                      {L.model}: <M style={{ fontSize: 11 }}>{detail.model}</M>
                    </Badge>
                  )}
                  {detail.prompt_version && (
                    <Badge tone="muted">
                      {L.promptV}: <M style={{ fontSize: 11 }}>{detail.prompt_version}</M>
                    </Badge>
                  )}
                </div>

                {detail.description && (
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>{detail.description}</div>
                )}

                {detail.preconditions && (
                  <div>
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 6 }}>
                      {L.preconditions}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                      {Array.isArray(detail.preconditions) ? detail.preconditions.join("، ") : String(detail.preconditions)}
                    </div>
                  </div>
                )}

                {/* Steps */}
                <div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8 }}>
                    {L.steps} ({steps.length})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {steps.map((s: any, i: number) => {
                      const assertions: any[] = Array.isArray(s.assertions) ? s.assertions : [];
                      const extractions: any[] = Array.isArray(s.extractions) ? s.extractions : [];
                      return (
                        <div
                          key={i}
                          style={{
                            border: "1px solid var(--border)",
                            borderRadius: 12,
                            background: "var(--surface-2)",
                            padding: "12px 14px",
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                          }}
                        >
                          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            <M style={{ color: "var(--text-muted)", fontSize: 11 }}>#{s.order ?? i + 1}</M>
                            <M style={{ color: "var(--text)", fontWeight: 700, whiteSpace: "nowrap" }}>
                              {(s.method ?? "").toUpperCase()} {s.path}
                            </M>
                          </div>

                          {s.request !== undefined && s.request !== null && (
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{L.request}</div>
                              <JsonBlock value={s.request} />
                            </div>
                          )}

                          {assertions.length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{L.assertions}</div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                {assertions.map((a: any, j: number) => (
                                  <div key={j} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                    <Badge tone="muted">
                                      <M style={{ fontSize: 10 }}>{a.type}</M>
                                    </Badge>
                                    {a.path && <M style={{ color: "var(--text-secondary)", fontSize: 11 }}>{a.path}</M>}
                                    {a.name && <M style={{ color: "var(--text-secondary)", fontSize: 11 }}>{a.name}</M>}
                                    {a.op && (
                                      <Badge tone="accent">
                                        <M style={{ fontSize: 10 }}>{a.op}</M>
                                      </Badge>
                                    )}
                                    {a.expected !== undefined && (
                                      <M style={{ color: "var(--text)", fontSize: 11 }}>
                                        {typeof a.expected === "object" ? JSON.stringify(a.expected) : String(a.expected)}
                                      </M>
                                    )}
                                    {a.max !== undefined && <M style={{ color: "var(--text)", fontSize: 11 }}>≤ {a.max}ms</M>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {extractions.length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{L.extractions}</div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {extractions.map((x: any, j: number) => (
                                  <M key={j} style={{ color: "var(--c-cyan)", fontSize: 11 }}>
                                    {x.name} ← {x.path}
                                  </M>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Reject modal */}
      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title={L.rejectTitle} testId="review-reject-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.reason} testId="review-reject-reason-select">
            <Select value={rejectCode} onChange={(e: any) => setRejectCode(e.target.value)}>
              <option value="incorrect">{L.rIncorrect}</option>
              <option value="shallow">{L.rShallow}</option>
              <option value="duplicate">{L.rDuplicate}</option>
              <option value="other">{L.rOther}</option>
            </Select>
          </Field>
          <Field label={L.reasonText} testId="review-reject-reason-textarea">
            <Textarea rows={3} value={rejectText} onChange={(e: any) => setRejectText(e.target.value)} />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setRejectOpen(false)} testId="review-reject-cancel-button">
              {L.cancel}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              testId="review-reject-confirm-button"
              onClick={() => selectedId && rejectCase(selectedId, rejectCode, rejectText)}
            >
              {L.confirmReject}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={L.editTitle} testId="review-edit-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={L.caseTitle} testId="review-edit-title-input">
            <Input value={editForm.title} onChange={(e: any) => setEditForm((f) => ({ ...f, title: e.target.value }))} />
          </Field>
          <Field label={L.description} testId="review-edit-description-textarea">
            <Textarea
              rows={3}
              value={editForm.description}
              onChange={(e: any) => setEditForm((f) => ({ ...f, description: e.target.value }))}
            />
          </Field>
          <Field label={L.priority} testId="review-edit-priority-select">
            <Select value={editForm.priority} onChange={(e: any) => setEditForm((f) => ({ ...f, priority: e.target.value }))}>
              {!["high", "medium", "low", ""].includes(editForm.priority) && (
                <option value={editForm.priority}>{editForm.priority}</option>
              )}
              <option value="high">{L.high}</option>
              <option value="medium">{L.medium}</option>
              <option value="low">{L.low}</option>
            </Select>
          </Field>
          <Field label={L.stepsJson} testId="review-edit-steps-textarea">
            <Textarea
              dir="ltr"
              rows={8}
              style={{ fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace", fontSize: 11.5 }}
              value={editForm.steps}
              onChange={(e: any) => setEditForm((f) => ({ ...f, steps: e.target.value }))}
            />
          </Field>
          <Field label={L.assertionsJson} testId="review-edit-assertions-textarea">
            <Textarea
              dir="ltr"
              rows={5}
              style={{ fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace", fontSize: 11.5 }}
              value={editForm.assertions}
              onChange={(e: any) => setEditForm((f) => ({ ...f, assertions: e.target.value }))}
            />
          </Field>
          {jsonError && <div style={{ fontSize: 13, color: "var(--error)" }}>{jsonError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setEditOpen(false)} testId="review-edit-cancel-button">
              {L.cancel}
            </Button>
            <Button variant="primary" disabled={saving} onClick={saveEdit} testId="review-edit-save-button">
              {L.save}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
