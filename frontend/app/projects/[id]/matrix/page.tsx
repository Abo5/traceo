"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { API, api, getToken } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { Badge, Button, Card, Empty, PageHeader, Pill, Progress, RefChip, Select, StatCard, StatusDot } from "@/components/ui";

type Tone = "success" | "warning" | "error" | "info" | "muted" | "accent";

function M({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span dir="ltr" style={{ fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace", fontSize: 12, ...style }}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  not_covered: "warning",
  covered_not_run: "info",
  passing: "success",
  failing: "error",
  errored: "warning",
};

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

export default function MatrixPage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useLang();

  const L =
    lang === "ar"
      ? {
          title: "مصفوفة التتبّع",
          sub: "متطلب → حالة اختبار → نتيجة — التغطية الكاملة في مكان واحد",
          coverage: "التغطية %",
          gaps: "فجوات",
          all: "الكل",
          not_covered: "غير مغطى",
          covered_not_run: "مغطى دون تشغيل",
          passing: "ناجح",
          failing: "فاشل",
          errored: "خطأ",
          exportXlsx: "تصدير Excel",
          exporting: "جارٍ التصدير…",
          lang: "لغة التصدير",
          langAr: "العربية",
          langEn: "الإنجليزية",
          langBoth: "ثنائي اللغة",
          matrix: "المصفوفة",
          empty: "لا توجد متطلبات مؤكّدة",
          emptyHint: "أكّد المتطلبات وولّد حالات لتظهر المصفوفة",
          emptyFiltered: "لا صفوف مطابقة للمرشّح",
          emptyFilteredHint: "جرّب مرشّحًا آخر",
          gapsTitle: "الفجوات",
          noGaps: "لا توجد فجوات — كل المتطلبات المؤكّدة مغطاة",
          gapNoCases: "لا حالات معتمدة",
          gapUnmappable: "تعذّر الربط بواجهة",
          gapNoEndpoint: "لا توجد واجهة مطابقة",
          gapDisabled: "لا حالات معتمدة (روابط موجودة)",
          targetGen: "توليد مستهدف",
          loadError: "تعذّر تحميل المصفوفة",
          retry: "إعادة المحاولة",
          cases: "حالة",
        }
      : {
          title: "Traceability matrix",
          sub: "requirement → test case → result — full coverage in one place",
          coverage: "Coverage %",
          gaps: "Gaps",
          all: "All",
          not_covered: "Not covered",
          covered_not_run: "Covered, not run",
          passing: "Passing",
          failing: "Failing",
          errored: "Errored",
          exportXlsx: "Export Excel",
          exporting: "Exporting…",
          lang: "Export language",
          langAr: "Arabic",
          langEn: "English",
          langBoth: "Bilingual",
          matrix: "Matrix",
          empty: "No confirmed requirements",
          emptyHint: "Confirm requirements and generate cases to populate the matrix",
          emptyFiltered: "No rows match the filter",
          emptyFilteredHint: "Try another filter",
          gapsTitle: "Gaps",
          noGaps: "No gaps — every confirmed requirement is covered",
          gapNoCases: "No approved cases",
          gapUnmappable: "Could not map to an endpoint",
          gapNoEndpoint: "No reachable endpoint",
          gapDisabled: "No approved cases (links exist)",
          targetGen: "Targeted generation",
          loadError: "Failed to load the matrix",
          retry: "Retry",
          cases: "cases",
        };

  const statusLabel = (s: string) =>
    (({
      not_covered: L.not_covered,
      covered_not_run: L.covered_not_run,
      passing: L.passing,
      failing: L.failing,
      errored: L.errored,
    } as Record<string, string>)[s] ?? s);

  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusF, setStatusF] = useState("all");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // FR-071 AC3 — the bilingual export must be selectable, not a hidden parameter.
  const [exportLang, setExportLang] = useState<"ar" | "en" | "both">("both");

  function load() {
    setLoading(true);
    setError(null);
    return api(`/projects/${id}/traceability`)
      .then((d) => setData(d ?? {}))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const gaps: any[] = Array.isArray(data?.gaps) ? data.gaps : [];
  const coverage = Math.round(Number(data?.coverage_pct ?? 0));

  const filtered = useMemo(
    () => (statusF === "all" ? rows : rows.filter((r) => r.status === statusF)),
    [rows, statusF]
  );

  async function exportXlsx() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadFile(
        `/projects/${id}/exports/matrix.xlsx?lang=${exportLang}`,
        `traceability-matrix-${exportLang}.xlsx`
      );
    } catch (e: any) {
      setExportError(e?.message || String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={
          <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {L.title} <RefChip id="FR-050" />
          </span>
        }
        sub={L.sub}
        actions={
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <Select
              aria-label={L.lang}
              value={exportLang}
              onChange={(e) => setExportLang(e.target.value as "ar" | "en" | "both")}
              style={{ height: 34, fontSize: 12, minWidth: 130 }}
            >
              <option value="both">{L.langBoth}</option>
              <option value="ar">{L.langAr}</option>
              <option value="en">{L.langEn}</option>
            </Select>
            <Button variant="secondary" disabled={exporting} onClick={exportXlsx}>
              {exporting ? L.exporting : L.exportXlsx}
            </Button>
          </div>
        }
      />

      {exportError && <div style={{ fontSize: 13, color: "var(--error)" }}>{exportError}</div>}

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
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <StatCard value={`${coverage}%`} label={L.coverage} color="var(--accent)" />
            <StatCard value={gaps.length} label={L.gaps} color={gaps.length > 0 ? "var(--warning)" : "var(--success)"} />
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              ["all", L.all],
              ["not_covered", L.not_covered],
              ["covered_not_run", L.covered_not_run],
              ["passing", L.passing],
              ["failing", L.failing],
              ["errored", L.errored],
            ].map(([v, label]) => (
              <Pill key={v} active={statusF === v} onClick={() => setStatusF(v)}>
                {label}
              </Pill>
            ))}
          </div>

          <Card title={L.matrix} pad={false}>
            {filtered.length === 0 ? (
              <Empty
                title={statusF === "all" ? L.empty : L.emptyFiltered}
                hint={statusF === "all" ? L.emptyHint : L.emptyFilteredHint}
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {filtered.map((row, i) => {
                  const req = row.requirement ?? {};
                  const cases: any[] = Array.isArray(row.cases) ? row.cases : [];
                  const passed = cases.filter((c) => c.latest_outcome === "passed").length;
                  const pct = cases.length > 0 ? (passed / cases.length) * 100 : 0;
                  const tone = STATUS_TONE[row.status] ?? "muted";
                  return (
                    <div
                      key={req.id ?? i}
                      style={{
                        display: "flex",
                        gap: 16,
                        alignItems: "flex-start",
                        padding: "14px 18px",
                        borderTop: i === 0 ? "none" : "1px solid var(--border)",
                      }}
                    >
                      <M style={{ color: "var(--accent)", fontWeight: 500, minWidth: 90, paddingTop: 2 }}>
                        {req.external_id ?? "—"}
                      </M>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          title={req.description}
                          dir="auto"
                          style={{
                            fontSize: 13,
                            color: "var(--text)",
                            lineHeight: 1.6,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {req.description}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                          {cases.length === 0 ? (
                            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>—</span>
                          ) : (
                            cases.map((c: any, j: number) => (
                              <Link
                                key={c.id ?? j}
                                href={`/projects/${id}/review?case=${c.id}`}
                                style={{ textDecoration: "none" }}
                              >
                                <span
                                  title={c.title}
                                  style={{
                                    display: "inline-flex",
                                    gap: 6,
                                    alignItems: "center",
                                    border: "1px solid var(--border)",
                                    borderRadius: 999,
                                    padding: "3px 10px",
                                    background: "var(--surface-2)",
                                    fontSize: 11,
                                    color: "var(--text-secondary)",
                                    maxWidth: 220,
                                  }}
                                >
                                  <StatusDot state={c.latest_outcome ?? c.state} />
                                  <span
                                    dir="auto"
                                    style={{
                                      display: "block",
                                      minWidth: 0,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {c.title}
                                  </span>
                                </span>
                              </Link>
                            ))
                          )}
                        </div>
                      </div>
                      <div style={{ width: 150, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                        <Badge tone={tone}>{statusLabel(row.status)}</Badge>
                        <div style={{ width: "100%" }}>
                          <Progress pct={pct} tone={row.status === "failing" ? "error" : row.status === "passing" ? "success" : undefined} />
                        </div>
                        <M style={{ fontSize: 10, color: "var(--text-muted)" }}>
                          {passed}/{cases.length} {L.cases}
                        </M>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title={`${L.gapsTitle} (${gaps.length})`}>
            {gaps.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--success)" }}>✓ {L.noGaps}</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                {gaps.map((g, i) => (
                  <div
                    key={g.requirement_id ?? i}
                    style={{
                      border: "1px solid var(--warning)",
                      background: "var(--warning-subtle, rgba(255,197,61,.16))",
                      borderRadius: 12,
                      padding: "12px 16px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                      <M style={{ color: "var(--warning)", fontWeight: 700 }}>{g.external_id ?? g.requirement_id}</M>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        {g.reason === "no_approved_cases"
                          ? L.gapNoCases
                          : g.reason === "unmappable"
                            ? L.gapUnmappable
                            : g.reason === "no_reachable_endpoint"
                              ? L.gapNoEndpoint
                              : g.reason === "all_cases_disabled"
                                ? L.gapDisabled
                                : g.reason}
                      </span>
                    </div>
                    {g.next_action && (
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{g.next_action}</div>
                    )}
                    <div>
                      <Link href={`/projects/${id}/generate?req=${g.requirement_id}`}>
                        <Button variant="secondary" size="sm">
                          {L.targetGen}
                        </Button>
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
