"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, pollJob } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { useCan } from "@/lib/permissions";
import { Badge, Button, Card, Empty, PageHeader, Progress, StatCard } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";

/**
 * QA Insight Agent (وكيل الرؤى) — the sixth engine.
 * 100% deterministic backend: no LLM, no fabricated identifiers. This screen only
 * reads GET /projects/{id}/insights and starts the deterministic builder job via
 * POST /projects/{id}/insights/generate (202 + job_id, polled like every other job).
 */

/** The 9 canonical category ids — identical strings in both backends and here. */
const CATEGORY_IDS = [
  "boundary_surprise",
  "exotic_input",
  "control_chars",
  "idempotency",
  "state_corruption",
  "permission_edge",
  "timing_dst",
  "resource_exhaustion",
  "downstream_failure",
] as const;

type CategoryId = (typeof CATEGORY_IDS)[number];

/** Literal backend status values — asserted via data-state, never via visible text. */
type InsightStatus = "covered" | "gap" | "n_a";

type CategoryRow = {
  id: CategoryId;
  covered_count: number;
  suggestable_count: number;
  status: InsightStatus;
};

const STATUS_TONE: Record<InsightStatus, BadgeTone> = {
  covered: "success",
  gap: "warning",
  n_a: "muted",
};

function num(x: any): number {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function jobPct(j: any): number {
  const p = Number(j?.progress ?? 0);
  if (!isFinite(p) || p <= 0) return 0;
  return Math.min(100, Math.round(p <= 1 ? p * 100 : p));
}

function M({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span dir="ltr" style={{ fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace", fontSize: 12, ...style }}>
      {children}
    </span>
  );
}

export default function InsightsPage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useLang();
  const canDo = useCan();
  const ar = lang === "ar";

  const L = ar
    ? {
        title: "الرؤى",
        sub: "وكيل رؤى حتمي — يقترح حالات الحواف المقيّدة بجرد الواجهات، بلا نموذج لغوي وبلا اتصال خارجي",
        categories: "فئات الحواف",
        selectAll: "تحديد كل الفجوات",
        clearAll: "إلغاء التحديد",
        covered: "مغطّاة",
        suggestable: "قابلة للاقتراح",
        totalCases: "حالة في الفئات",
        totalCovered: "فئة مغطّاة",
        totalSuggestable: "اقتراح متاح",
        summary: "الملخّص",
        selected: "فئة محددة",
        info: "كل حالة يولّدها الوكيل تُشتق من جرد الواجهات المكتشفة وتمرّ ببوابة التحقق قبل الحفظ — لا معرّفات مُختلقة",
        generate: "توليد حالات الحواف",
        generating: "جارٍ التوليد…",
        result: "نتيجة التوليد",
        created: "أُنشئت",
        discarded: "استُبعدت",
        toReview: "الانتقال إلى المراجعة",
        empty: "لا توجد رؤى بعد",
        emptyHint: "استورد مواصفة الواجهات وأكّد المتطلبات ليتمكّن الوكيل من التأسيس عليها",
        loadError: "تعذّر تحميل الرؤى",
        retry: "إعادة المحاولة",
        invalidCategory: "فئة غير مشروعة — أعد التحديد",
        statusCovered: "مغطّاة",
        statusGap: "فجوة",
        statusNa: "غير منطبقة",
        naHint: "لا يوجد ما تتأسس عليه هذه الفئة في جرد الواجهات الحالي",
      }
    : {
        title: "Insights",
        sub: "Deterministic insight agent — grounds edge-case suggestions in the endpoint inventory, no LLM, fully offline",
        categories: "Edge categories",
        selectAll: "Select all gaps",
        clearAll: "Clear selection",
        covered: "Covered",
        suggestable: "Suggestable",
        totalCases: "cases in categories",
        totalCovered: "categories covered",
        totalSuggestable: "suggestions available",
        summary: "Summary",
        selected: "categories selected",
        info: "Every case the agent emits is derived from the discovered endpoint inventory and passes the grounding gate before saving — zero fabricated identifiers",
        generate: "Generate edge cases",
        generating: "Generating…",
        result: "Generation result",
        created: "Created",
        discarded: "Discarded",
        toReview: "Go to review",
        empty: "No insights yet",
        emptyHint: "Import an API spec and confirm requirements so the agent has something to ground itself in",
        loadError: "Failed to load insights",
        retry: "Retry",
        invalidCategory: "Illegal category — adjust the selection",
        statusCovered: "Covered",
        statusGap: "Gap",
        statusNa: "N/A",
        naHint: "Nothing in the current endpoint inventory for this category to ground itself in",
      };

  /** Bilingual taxonomy labels + one-line explanations (Arabic first, QA terminology). */
  const CATEGORY_LABELS: Record<CategoryId, { label: string; hint: string }> = ar
    ? {
        boundary_surprise: {
          label: "حدود مفاجئة",
          hint: "أخطاء الانزياح بواحد وحواف الحدود القصوى بما يتجاوز تحليل قيم الحدود التقليدي",
        },
        exotic_input: {
          label: "مدخلات استثنائية",
          hint: "عربية واتجاه RTL، رموز تعبيرية، تطبيع NFC مقابل NFD، محارف صفرية العرض، سلاسل طويلة جداً",
        },
        control_chars: {
          label: "محارف تحكّم",
          hint: "بايت صفري ومحارف تحكّم داخل الحقول النصية",
        },
        idempotency: {
          label: "تكرار العملية",
          hint: "إرسال مكرّر أو مُعاد لنفس الطلب المُعدِّل دون أثر جانبي مضاعف",
        },
        state_corruption: {
          label: "إفساد الحالة",
          hint: "انتقالات حالة خارج الترتيب أو غير مسموح بها",
        },
        permission_edge: {
          label: "حواف الصلاحيات",
          hint: "نفس الطلب بمنفّذ أدنى صلاحية",
        },
        timing_dst: {
          label: "التوقيت والتوقيت الصيفي",
          hint: "المناطق الزمنية والتوقيت الصيفي وتدحرج التاريخ على حقول التاريخ/الوقت",
        },
        resource_exhaustion: {
          label: "استنزاف الموارد",
          hint: "حمولة ضخمة أو قيم ترقيم صفحات متطرفة",
        },
        downstream_failure: {
          label: "أعطال التبعيات",
          hint: "انتشار أخطاء الخدمات التابعة وأشكال استجابات الفشل",
        },
      }
    : {
        boundary_surprise: {
          label: "Boundary surprises",
          hint: "Off-by-one and limit edges beyond plain boundary-value analysis",
        },
        exotic_input: {
          label: "Exotic input",
          hint: "Arabic/RTL, emoji, NFC-vs-NFD normalization, zero-width characters, very long strings",
        },
        control_chars: {
          label: "Control characters",
          hint: "Null bytes and control characters inside string fields",
        },
        idempotency: {
          label: "Idempotency",
          hint: "Duplicate or replayed submit of the same mutating request, with no doubled side effect",
        },
        state_corruption: {
          label: "State corruption",
          hint: "Out-of-order or illegal state transitions",
        },
        permission_edge: {
          label: "Permission edges",
          hint: "The same request issued by a lower-privileged actor",
        },
        timing_dst: {
          label: "Timing & DST",
          hint: "Timezone, DST and date-rollover values on date-time fields",
        },
        resource_exhaustion: {
          label: "Resource exhaustion",
          hint: "Oversized payloads or extreme pagination values",
        },
        downstream_failure: {
          label: "Downstream failures",
          hint: "Dependency error propagation and failure response shapes",
        },
      };

  const STATUS_LABEL: Record<InsightStatus, string> = {
    covered: L.statusCovered,
    gap: L.statusGap,
    n_a: L.statusNa,
  };

  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<{ msg: string; pct: number } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    return api(`/projects/${id}/insights`)
      .then((d: any) => setData(d ?? {}))
      .catch((e: any) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * The taxonomy is fixed: always render the 9 canonical ids in canonical order,
   * merging whatever the server returned. Unknown ids are ignored, missing ones
   * fall back to an empty non-applicable row.
   */
  const rows: CategoryRow[] = useMemo(() => {
    const raw: any[] = Array.isArray(data?.categories) ? data.categories : [];
    const byId: Record<string, any> = {};
    raw.forEach((c) => {
      if (c && typeof c.id === "string") byId[c.id] = c;
    });
    return CATEGORY_IDS.map((cid) => {
      const c = byId[cid];
      const covered = num(c?.covered_count);
      const suggestable = num(c?.suggestable_count);
      const status: InsightStatus =
        c?.status === "covered" || c?.status === "gap" || c?.status === "n_a"
          ? c.status
          : covered > 0
            ? "covered"
            : suggestable > 0
              ? "gap"
              : "n_a";
      return { id: cid, covered_count: covered, suggestable_count: suggestable, status };
    });
  }, [data]);

  const selectable = rows.filter((r) => r.suggestable_count > 0);
  const allSelectableSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));

  const totalCases = num(data?.total_cases);
  const totalCovered = num(data?.total_covered);
  const totalSuggestable = num(data?.total_suggestable);
  const hasAnything = rows.some((r) => r.covered_count > 0 || r.suggestable_count > 0);

  function toggle(cid: string, allowed: boolean) {
    if (!allowed) return;
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(cid)) n.delete(cid);
      else n.add(cid);
      return n;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const n = new Set(prev);
      if (allSelectableSelected) selectable.forEach((r) => n.delete(r.id));
      else selectable.forEach((r) => n.add(r.id));
      return n;
    });
  }

  async function generate() {
    setGenError(null);
    setResult(null);
    setJob({ msg: L.generating, pct: 2 });
    try {
      const res = await api(`/projects/${id}/insights/generate`, {
        body: { categories: [...selected] },
      });
      const out = await pollJob(res.job_id, (j) =>
        setJob({ msg: j?.message || L.generating, pct: jobPct(j) })
      );
      setResult(out ?? {});
      setSelected(new Set());
      load();
    } catch (e: any) {
      setGenError(e?.code === "invalid_category" ? L.invalidCategory : e?.message || String(e));
    } finally {
      setJob(null);
    }
  }

  const created = num(result?.created ?? result?.generated);
  const discarded = num(result?.discarded);

  return (
    <div data-testid="insights-page-root" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={L.title} sub={L.sub} testId="insights-page-header" />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <StatCard value={totalCases} label={L.totalCases} testId="insights-total-cases-stat" />
        <StatCard value={totalCovered} label={L.totalCovered} color="var(--success)" testId="insights-total-covered-stat" />
        <StatCard value={totalSuggestable} label={L.totalSuggestable} color="var(--accent)" testId="insights-total-suggestable-stat" />
      </div>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Taxonomy rows */}
        <div style={{ flex: 1, minWidth: 340 }}>
          <Card
            title={L.categories}
            testId="insights-categories-card"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleAll}
                disabled={selectable.length === 0}
                testId="insights-select-all-button"
              >
                {allSelectableSelected ? L.clearAll : L.selectAll}
              </Button>
            }
          >
            {loading ? (
              <div style={{ padding: 24, color: "var(--text-secondary)", fontSize: 13 }}>…</div>
            ) : error ? (
              <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                <div style={{ color: "var(--error)", fontSize: 13 }} data-testid="insights-page-error-text">
                  {L.loadError} — {error}
                </div>
                <Button variant="secondary" size="sm" onClick={() => load()} testId="insights-retry-button">
                  {L.retry}
                </Button>
              </div>
            ) : !hasAnything ? (
              <Empty title={L.empty} hint={L.emptyHint} testId="insights-empty-state" />
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {rows.map((r, i) => {
                  const meta = CATEGORY_LABELS[r.id];
                  const allowed = r.suggestable_count > 0;
                  return (
                    <label
                      key={r.id}
                      data-testid="insights-category-row"
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "flex-start",
                        padding: "12px 4px",
                        borderTop: i === 0 ? "none" : "1px solid var(--border)",
                        cursor: allowed ? "pointer" : "default",
                        opacity: allowed ? 1 : 0.72,
                      }}
                    >
                      <input
                        type="checkbox"
                        data-testid="insights-category-checkbox"
                        checked={selected.has(r.id)}
                        disabled={!allowed}
                        onChange={() => toggle(r.id, allowed)}
                        style={{ marginTop: 4, accentColor: "var(--accent)" }}
                      />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                          <span dir="auto" style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                            {meta.label}
                          </span>
                          {/* text-secondary, not text-muted: 11px muted fails WCAG AA contrast */}
                          <M style={{ color: "var(--text-secondary)", fontSize: 11 }}>{r.id}</M>
                        </div>
                        <div dir="auto" style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7, marginTop: 3 }}>
                          {r.status === "n_a" ? L.naHint : meta.hint}
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 16, alignItems: "center", flexShrink: 0 }}>
                        <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <M style={{ fontSize: 15, fontWeight: 700, color: r.covered_count > 0 ? "var(--success)" : "var(--text-secondary)" }}>
                            {r.covered_count}
                          </M>
                          <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{L.covered}</span>
                        </span>
                        <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <M style={{ fontSize: 15, fontWeight: 700, color: allowed ? "var(--accent)" : "var(--text-secondary)" }}>
                            {r.suggestable_count}
                          </M>
                          <span style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{L.suggestable}</span>
                        </span>
                        <span style={{ minWidth: 72, display: "flex", justifyContent: "flex-end" }}>
                          <Badge
                            tone={STATUS_TONE[r.status]}
                            state={r.status}
                            testId="insights-category-status-badge"
                          >
                            {STATUS_LABEL[r.status]}
                          </Badge>
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Sticky summary */}
        <div style={{ width: 320, flexShrink: 0, position: "sticky", top: 84 }}>
          <Card title={L.summary} testId="insights-summary-card">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <M style={{ fontSize: 24, fontWeight: 700, color: "var(--text)" }}>{selected.size}</M>
                <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{L.selected}</span>
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
                  <Progress pct={job.pct} tone="accent" testId="insights-job-progress" />
                  <M style={{ color: "var(--text-secondary)" }}>{job.pct}%</M>
                </div>
              ) : (
                canDo("generate") && (
                  <Button disabled={selected.size === 0} onClick={generate} testId="insights-generate-button">
                    {L.generate}
                  </Button>
                )
              )}

              {genError && (
                <div style={{ fontSize: 13, color: "var(--error)" }} data-testid="insights-generate-error-text">
                  {genError}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Result panel */}
      {result && (
        <Card title={L.result} testId="insights-result-card">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
              <StatCard value={created} label={L.created} color="var(--success)" testId="insights-created-stat" />
              <StatCard value={discarded} label={L.discarded} color="var(--error)" testId="insights-discarded-stat" />
            </div>

            <div>
              <Link href={`/projects/${id}/review`}>
                <Button variant="secondary" testId="insights-to-review-button">
                  {L.toReview} ←
                </Button>
              </Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
