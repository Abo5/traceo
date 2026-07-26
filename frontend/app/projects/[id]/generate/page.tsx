"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { api, pollJob } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { Badge, Button, Card, Empty, PageHeader, Pill, Progress, StatCard } from "@/components/ui";

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.requirements ?? x?.endpoints ?? [];
}

function jobPct(j: any): number {
  const p = Number(j?.progress ?? 0);
  if (!isFinite(p) || p <= 0) return 0;
  return Math.min(100, Math.round(p <= 1 ? p * 100 : p));
}

function M({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span dir="ltr" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, ...style }}>
      {children}
    </span>
  );
}

function GenerateInner() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const { lang } = useLang();

  const L =
    lang === "ar"
      ? {
          title: "التوليد",
          sub: "ولّد حالات اختبار مقيّدة بالواجهات من المتطلبات المؤكّدة",
          reqs: "المتطلبات المؤكّدة",
          selectAll: "تحديد الكل",
          clearAll: "إلغاء التحديد",
          all: "الكل",
          high: "عالية",
          medium: "متوسطة",
          low: "منخفضة",
          depth: "عمق التوليد",
          smoke: "دخان",
          smokeHint: "الحالات الإيجابية الأساسية فقط — الأسرع",
          standard: "قياسي",
          standardHint: "إيجابية + فئات التكافؤ + قيم الحدود",
          exhaustive: "شامل",
          exhaustiveHint: "مسح القوائم وجداول القرار للمدخلات المتقاطعة",
          summary: "الملخّص",
          selected: "متطلب محدد",
          endpoints: "واجهة مكتشفة",
          info: "التوليد مقيّد بالواجهات المكتشفة فقط — أي حالة تشير إلى واجهة غير موجودة تُستبعد قبل الحفظ",
          generate: "توليد حالات الاختبار",
          generating: "جارٍ التوليد…",
          result: "نتيجة التوليد",
          generated: "توليد",
          discarded: "استبعاد",
          unmappable: "متطلبات تعذّر ربطها",
          toReview: "الانتقال إلى المراجعة",
          empty: "لا توجد متطلبات مؤكّدة",
          emptyHint: "أكّد المتطلبات من صفحة المتطلبات أولاً",
          loadError: "تعذّر تحميل البيانات",
          retry: "إعادة المحاولة",
        }
      : {
          title: "Generate",
          sub: "Generate endpoint-grounded test cases from confirmed requirements",
          reqs: "Confirmed requirements",
          selectAll: "Select all",
          clearAll: "Clear selection",
          all: "All",
          high: "High",
          medium: "Medium",
          low: "Low",
          depth: "Generation depth",
          smoke: "Smoke",
          smokeHint: "Core positive cases only — fastest",
          standard: "Standard",
          standardHint: "Positive + equivalence classes + boundary values",
          exhaustive: "Exhaustive",
          exhaustiveHint: "Enum sweeps and decision tables for interacting inputs",
          summary: "Summary",
          selected: "requirements selected",
          endpoints: "endpoints discovered",
          info: "Generation is grounded in discovered endpoints only — any case referencing a non-existent endpoint is discarded before saving",
          generate: "Generate test cases",
          generating: "Generating…",
          result: "Generation result",
          generated: "Generated",
          discarded: "Discarded",
          unmappable: "Unmappable requirements",
          toReview: "Go to review",
          empty: "No confirmed requirements",
          emptyHint: "Confirm requirements on the Requirements page first",
          loadError: "Failed to load data",
          retry: "Retry",
        };

  const DEPTHS: { v: string; label: string; hint: string }[] = [
    { v: "smoke", label: L.smoke, hint: L.smokeHint },
    { v: "standard", label: L.standard, hint: L.standardHint },
    { v: "exhaustive", label: L.exhaustive, hint: L.exhaustiveHint },
  ];

  const [reqs, setReqs] = useState<any[]>([]);
  const [endpoints, setEndpoints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prioF, setPrioF] = useState("all");
  const [depth, setDepth] = useState("standard");

  const [job, setJob] = useState<{ msg: string; pct: number } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    return Promise.all([
      api(`/projects/${id}/requirements?state=confirmed`),
      api(`/projects/${id}/endpoints`),
    ])
      .then(([r, e]) => {
        const list = asList(r);
        setReqs(list);
        setEndpoints(asList(e));
        const pre = search.get("req");
        if (pre && list.some((x: any) => x.id === pre)) {
          setSelected(new Set([pre]));
        }
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const filtered = useMemo(
    () => (prioF === "all" ? reqs : reqs.filter((r) => r.priority === prioF)),
    [reqs, prioF]
  );

  const activeEndpoints = endpoints.filter((e) => !e.excluded).length;
  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  function toggle(rid: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(rid)) n.delete(rid);
      else n.add(rid);
      return n;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const n = new Set(prev);
      if (allFilteredSelected) filtered.forEach((r) => n.delete(r.id));
      else filtered.forEach((r) => n.add(r.id));
      return n;
    });
  }

  async function generate() {
    setGenError(null);
    setResult(null);
    setJob({ msg: L.generating, pct: 2 });
    try {
      const res = await api(`/projects/${id}/generate`, {
        body: { requirement_ids: [...selected], depth },
      });
      const out = await pollJob(res.job_id, (j) =>
        setJob({ msg: j?.message || L.generating, pct: jobPct(j) })
      );
      setResult(out ?? {});
    } catch (e: any) {
      setGenError(e?.message || String(e));
    } finally {
      setJob(null);
    }
  }

  const unmappable: any[] = Array.isArray(result?.unmappable) ? result.unmappable : [];
  const reqById = useMemo(() => {
    const m: Record<string, any> = {};
    reqs.forEach((r) => (m[r.id] = r));
    return m;
  }, [reqs]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={L.title} sub={L.sub} />

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Checklist */}
        <div style={{ flex: 1, minWidth: 340, display: "flex", flexDirection: "column", gap: 20 }}>
          <Card
            title={L.reqs}
            action={
              <Button variant="ghost" size="sm" onClick={toggleAll} disabled={filtered.length === 0}>
                {allFilteredSelected ? L.clearAll : L.selectAll}
              </Button>
            }
          >
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              {[
                ["all", L.all],
                ["high", L.high],
                ["medium", L.medium],
                ["low", L.low],
              ].map(([v, label]) => (
                <Pill key={v} active={prioF === v} onClick={() => setPrioF(v)}>
                  {label}
                </Pill>
              ))}
            </div>

            {loading ? (
              <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>…</div>
            ) : error ? (
              <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                <div style={{ color: "var(--error)", fontSize: 13 }}>
                  {L.loadError} — {error}
                </div>
                <Button variant="secondary" size="sm" onClick={() => load()}>
                  {L.retry}
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <Empty title={L.empty} hint={L.emptyHint} />
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {filtered.map((r, i) => (
                  <label
                    key={r.id}
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                      padding: "10px 4px",
                      borderTop: i === 0 ? "none" : "1px solid var(--border)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      style={{ marginTop: 4, accentColor: "var(--accent)" }}
                    />
                    <M style={{ color: "var(--accent)", minWidth: 80, paddingTop: 2 }}>
                      {r.external_id ?? "—"}
                    </M>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>{r.description}</div>
                      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                        {r.type && <Badge tone="info">{r.type}</Badge>}
                        {r.priority && (
                          <Badge tone={r.priority === "high" ? "error" : r.priority === "medium" ? "warning" : "muted"}>
                            {r.priority}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </Card>

          <Card title={L.depth}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {DEPTHS.map((d) => (
                <button
                  key={d.v}
                  type="button"
                  onClick={() => setDepth(d.v)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    textAlign: "start",
                    padding: "12px 14px",
                    borderRadius: 12,
                    cursor: "pointer",
                    border: depth === d.v ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: depth === d.v ? "var(--accent-subtle)" : "var(--surface-2)",
                    transition: "border-color 120ms, background 120ms",
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      flexShrink: 0,
                      border: depth === d.v ? "4px solid var(--accent)" : "2px solid var(--border-strong)",
                      background: "var(--bg)",
                    }}
                  />
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                      {d.label} <M style={{ color: "var(--text-muted)", fontSize: 11 }}>{d.v}</M>
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{d.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </div>

        {/* Sticky summary */}
        <div style={{ width: 320, flexShrink: 0, position: "sticky", top: 84 }}>
          <Card title={L.summary}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <M style={{ fontSize: 24, fontWeight: 700, color: "var(--text)" }}>{selected.size}</M>
                <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{L.selected}</span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <M style={{ fontSize: 24, fontWeight: 700, color: "var(--text)" }}>{activeEndpoints}</M>
                <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{L.endpoints}</span>
              </div>

              <div
                style={{
                  border: "1px solid var(--accent)",
                  background: "var(--accent-subtle)",
                  borderRadius: 12,
                  padding: "10px 14px",
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: "var(--accent)",
                }}
              >
                {L.info}
              </div>

              {job ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 13, color: "var(--text)" }}>{job.msg}</div>
                  <Progress pct={job.pct} tone="accent" />
                  <M style={{ color: "var(--text-muted)" }}>{job.pct}%</M>
                </div>
              ) : (
                <Button disabled={selected.size === 0} onClick={generate}>
                  {L.generate}
                </Button>
              )}

              {genError && <div style={{ fontSize: 13, color: "var(--error)" }}>{genError}</div>}
            </div>
          </Card>
        </div>
      </div>

      {/* Result panel */}
      {result && (
        <Card title={L.result}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
              <StatCard value={result.generated ?? 0} label={L.generated} color="var(--success)" />
              <StatCard value={result.discarded ?? 0} label={L.discarded} color="var(--error)" />
            </div>

            {unmappable.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--warning)",
                  background: "var(--warning-subtle, rgba(255,197,61,.16))",
                  borderRadius: 12,
                  padding: "12px 16px",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--warning)", marginBottom: 8 }}>
                  {L.unmappable} ({unmappable.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {unmappable.map((u, i) => {
                    const req = reqById[u.requirement_id];
                    return (
                      <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                        <M style={{ color: "var(--warning)" }}>
                          {req?.external_id ?? u.requirement_id}
                        </M>
                        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{u.reason}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <Link href={`/projects/${id}/review`}>
                <Button variant="secondary">{L.toReview} ←</Button>
              </Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function GeneratePage() {
  return (
    <Suspense fallback={null}>
      <GenerateInner />
    </Suspense>
  );
}
