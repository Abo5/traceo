"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, API, getToken } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { Badge, Button, Card, Empty, Field, Input, Mono, PageHeader, RefChip, Table } from "@/components/ui";

type AuditEntry = {
  id: string;
  actor_id: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  detail: Record<string, any>;
  occurred_at: string | null;
};

function actionTone(action: string): "success" | "warning" | "error" | "info" | "muted" | "accent" {
  if (action.includes("delete") || action.includes("reject")) return "error";
  if (action.includes("create") || action.includes("approve") || action.includes("invite"))
    return "success";
  if (action.includes("archive") || action.includes("stale")) return "warning";
  if (action.includes("login") || action.includes("register") || action.includes("auth"))
    return "info";
  if (action.includes("run")) return "accent";
  return "muted";
}

export default function AuditPage() {
  const { lang } = useLang();
  const ar = lang === "ar";

  const L = ar
    ? {
        title: "سجل التدقيق",
        sub: "كل الإجراءات الحساسة في المنشأة — الأحدث أولًا",
        members: "الأعضاء",
        time: "الوقت",
        actor: "المنفّذ",
        action: "الإجراء",
        object: "الكائن",
        detail: "التفاصيل",
        loadMore: "تحميل المزيد",
        empty: "لا توجد سجلات بعد",
        emptyHint: "ستظهر هنا أحداث الدخول والتعديلات والاعتمادات والتشغيلات",
        loading: "جارٍ التحميل…",
        tokens: "رموز الوصول",
        retention: "مدة الاحتفاظ (بالأيام)",
        retentionHint:
          "لا يمكن حذف أي سجل قبل تاريخ احتفاظه — والسجل غير قابل للتعديل بأي حال",
        entries: "إجمالي السجلات",
        pastRetention: "تجاوزت مدة الاحتفاظ",
        saveRetention: "حفظ المدة",
        purge: "تنظيف المنتهية",
        exportCsv: "تصدير CSV",
        purged: "تم حذف السجلات المنتهية",
        saved: "حُفظت مدة الاحتفاظ",
      }
    : {
        title: "Audit log",
        sub: "Every sensitive action in the organisation — newest first",
        members: "Members",
        time: "Time",
        actor: "Actor",
        action: "Action",
        object: "Object",
        detail: "Detail",
        loadMore: "Load more",
        empty: "No entries yet",
        emptyHint: "Logins, edits, approvals and runs will appear here",
        loading: "Loading…",
        tokens: "API tokens",
        retention: "Retention (days)",
        retentionHint:
          "No entry can be removed before its retention date — and no entry is editable at all",
        entries: "Total entries",
        pastRetention: "Past retention",
        saveRetention: "Save retention",
        purge: "Purge expired",
        exportCsv: "Export CSV",
        purged: "Expired entries removed",
        saved: "Retention saved",
      };

  const [items, setItems] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retention, setRetention] = useState<{
    retention_days: number;
    entries: number;
    past_retention: number;
  } | null>(null);
  const [days, setDays] = useState(90);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function loadRetention() {
    try {
      const res = await api<any>("/audit/retention");
      setRetention(res);
      setDays(res.retention_days);
    } catch {
      /* a non-admin viewer simply does not see the panel */
    }
  }

  async function saveRetention() {
    setBusy("retention");
    try {
      await api("/audit/retention", { method: "PUT", body: { retention_days: days } });
      await loadRetention();
      setNote(L.saved);
      setTimeout(() => setNote(null), 2500);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function purge() {
    setBusy("purge");
    try {
      const res = await api<any>("/audit/purge", { body: {} });
      await loadRetention();
      setNote(`${L.purged} (${res.removed})`);
      setTimeout(() => setNote(null), 2500);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function exportCsv() {
    setBusy("export");
    try {
      const res = await fetch(`${API}/audit/export.csv`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "traceo-audit.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function load(nextCursor?: string | null) {
    const qs = new URLSearchParams({ limit: "50" });
    if (nextCursor) qs.set("cursor", nextCursor);
    const res = await api<{ items: AuditEntry[]; next_cursor: string | null }>(
      `/audit?${qs.toString()}`
    );
    return res;
  }

  useEffect(() => {
    let alive = true;
    load()
      .then((res) => {
        if (!alive) return;
        setItems(res.items ?? []);
        setCursor(res.next_cursor ?? null);
      })
      .catch((e) => alive && setError(e?.message || String(e)))
      .finally(() => alive && setLoading(false));
    loadRetention();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await load(cursor);
      setItems((prev) => [...prev, ...(res.items ?? [])]);
      setCursor(res.next_cursor ?? null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title={
          <>
            {L.title} <RefChip id="FR-082" />
          </>
        }
        sub={L.sub}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Link href="/settings/members">
              <Button variant="ghost" size="sm">
                {L.members}
              </Button>
            </Link>
            <Link href="/settings/tokens">
              <Button variant="ghost" size="sm">
                {L.tokens}
              </Button>
            </Link>
            <Button size="sm" onClick={exportCsv} disabled={busy === "export"}>
              {L.exportCsv}
            </Button>
          </div>
        }
      />

      {error && <div className="error-text">{error}</div>}
      {note && <div style={{ color: "var(--success)", fontSize: 13 }}>{note}</div>}

      {retention && (
        <Card title={L.retention}>
          <div className="field-hint" style={{ marginBottom: 12 }}>{L.retentionHint}</div>
          <div
            className="row"
            style={{ gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}
          >
            <Field label={L.retention}>
              <Input
                type="number"
                min={1}
                max={3650}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                style={{ width: 120 }}
              />
            </Field>
            <Button onClick={saveRetention} disabled={busy === "retention"}>
              {L.saveRetention}
            </Button>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {L.entries}: <strong>{retention.entries}</strong> · {L.pastRetention}:{" "}
              <strong style={{ color: retention.past_retention ? "var(--warning)" : undefined }}>
                {retention.past_retention}
              </strong>
            </div>
            <Button
              variant="ghost"
              onClick={purge}
              disabled={busy === "purge" || !retention.past_retention}
            >
              {L.purge}
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{L.loading}</div>
      ) : items.length === 0 ? (
        <Empty title={L.empty} hint={L.emptyHint} />
      ) : (
        <>
          <div className="card" style={{ padding: "6px 18px 12px" }}>
            <Table head={[L.time, L.actor, L.action, L.object, L.detail]}>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Mono style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {e.occurred_at ? e.occurred_at.slice(0, 19).replace("T", " ") : "—"}
                    </Mono>
                  </td>
                  <td>
                    <Mono style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      {e.actor_id ? e.actor_id.slice(0, 8) : "—"}
                    </Mono>
                  </td>
                  <td>
                    <Badge tone={actionTone(e.action)}>
                      <Mono style={{ fontSize: 11 }}>{e.action}</Mono>
                    </Badge>
                  </td>
                  <td>
                    <Mono style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {e.object_type ?? "—"}
                      {e.object_id ? ` · ${e.object_id.slice(0, 8)}` : ""}
                    </Mono>
                  </td>
                  <td style={{ maxWidth: 340 }}>
                    <Mono
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.detail && Object.keys(e.detail).length
                        ? JSON.stringify(e.detail)
                        : "—"}
                    </Mono>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
          {cursor && (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Button variant="secondary" disabled={loadingMore} onClick={more}>
                {L.loadMore}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
