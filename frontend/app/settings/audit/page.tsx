"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { Badge, Button, Empty, Mono, PageHeader, Table } from "@/components/ui";

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
      };

  const [items, setItems] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="stack" data-testid="audit-page-root">
      <PageHeader
        title={L.title}
        sub={L.sub}
        testId="audit-page-header"
        actions={
          <Link href="/settings/members">
            <Button variant="ghost" size="sm" testId="audit-members-link-button">
              {L.members}
            </Button>
          </Link>
        }
      />

      {error && <div className="error-text" data-testid="audit-error-text">{error}</div>}

      {loading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{L.loading}</div>
      ) : items.length === 0 ? (
        <Empty title={L.empty} hint={L.emptyHint} testId="audit-empty-state" />
      ) : (
        <>
          <div className="card" style={{ padding: "6px 18px 12px" }}>
            <Table head={[L.time, L.actor, L.action, L.object, L.detail]} testId="audit-table-root">
              {items.map((e) => (
                <tr key={e.id} data-testid="audit-row">
                  <td>
                    <Mono style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {e.occurred_at ? e.occurred_at.slice(0, 19).replace("T", " ") : "—"}
                    </Mono>
                  </td>
                  <td>
                    <Mono style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {e.actor_id ? e.actor_id.slice(0, 8) : "—"}
                    </Mono>
                  </td>
                  <td>
                    <Badge tone={actionTone(e.action)} testId="audit-row-action-badge">
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
                        color: "var(--text-secondary)",
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
              <Button variant="secondary" disabled={loadingMore} testId="audit-load-more-button" onClick={more}>
                {L.loadMore}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
