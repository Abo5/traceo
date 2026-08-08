"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { useCan } from "@/lib/permissions";
import { Badge, Button, Card, DateTimeText, Empty, Field, Input, Modal, PageHeader, Select, StatusDot, Table, stateTone } from "@/components/ui";

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.results ?? x?.runs ?? x?.environments ?? x?.test_cases ?? [];
}

function M({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span dir="ltr" style={{ fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace", fontSize: 12, ...style }}>
      {children}
    </span>
  );
}

function shortId(id?: string): string {
  return id ? String(id).slice(0, 8) : "—";
}

const TERMINAL = ["completed", "aborted", "cancelled", "failed"];

/** 26px tinted numbered chip (design spec §2.20). */
function NumberedChip({ n, color }: { n: string; color: string }) {
  return (
    <span
      dir="ltr"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        borderRadius: 8,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color,
        fontFamily: "'JetBrains Mono',ui-monospace,monospace",
        fontSize: 12,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {n}
    </span>
  );
}

export default function RunsPage() {
  const { id } = useParams<{ id: string }>();
  const { lang } = useLang();
  const canDo = useCan();

  const L =
    lang === "ar"
      ? {
          title: "التشغيلات",
          sub: "شغّل الحالات المعتمدة ضد بيئة وتابع النتائج مباشرة",
          launch: "تشغيل جديد",
          env: "البيئة",
          pickEnv: "اختر بيئة…",
          approvedCount: "حالة معتمدة جاهزة للتشغيل",
          subset: "تشغيل مجموعة فرعية",
          subsetPicked: "حالة محددة",
          subsetTitle: "اختيار مجموعة فرعية",
          subsetHint: "اترك الاختيار فارغًا لتشغيل جميع الحالات المعتمدة",
          apply: "تطبيق",
          clear: "مسح",
          run: "تشغيل",
          launching: "جارٍ الإطلاق…",
          live: "التشغيل الجاري",
          cancel: "إلغاء التشغيل",
          report: "عرض التقرير",
          total: "الكل",
          passed: "ناجح",
          failed: "فاشل",
          errored: "خطأ",
          skipped: "متجاوز",
          history: "سجل التشغيلات",
          runId: "المعرّف",
          state: "الحالة",
          counts: "النتائج",
          started: "البداية",
          finished: "النهاية",
          initiator: "المشغّل",
          noRuns: "لا توجد تشغيلات بعد",
          noRunsHint: "شغّل الحالات المعتمدة لبدء التتبّع",
          noEnvs: "لا توجد بيئات — أنشئ بيئة أولاً من صفحة البيئات",
          noApproved: "لا توجد حالات معتمدة — اعتمد حالات من صفحة المراجعة",
          loadError: "تعذّر تحميل البيانات",
          retry: "إعادة المحاولة",
          search: "بحث…",
          step1: "الهدف",
          step2: "النطاق",
          step3: "القواعد",
          rulesHint: "تقنيات التوليد المفعّلة — للقراءة فقط",
          techniques: ["EP", "BVA", "سلبي", "جداول القرار", "التعريب"],
        }
      : {
          title: "Runs",
          sub: "Execute approved cases against an environment and watch results live",
          launch: "New run",
          env: "Environment",
          pickEnv: "Pick an environment…",
          approvedCount: "approved cases ready to run",
          subset: "Run a subset",
          subsetPicked: "cases selected",
          subsetTitle: "Pick a subset",
          subsetHint: "Leave empty to run all approved cases",
          apply: "Apply",
          clear: "Clear",
          run: "Run",
          launching: "Launching…",
          live: "Live run",
          cancel: "Cancel run",
          report: "View report",
          total: "Total",
          passed: "Passed",
          failed: "Failed",
          errored: "Errored",
          skipped: "Skipped",
          history: "Run history",
          runId: "ID",
          state: "State",
          counts: "Counts",
          started: "Started",
          finished: "Finished",
          initiator: "Initiator",
          noRuns: "No runs yet",
          noRunsHint: "Run approved cases to start tracing",
          noEnvs: "No environments — create one on the Environments page first",
          noApproved: "No approved cases — approve cases on the Review page",
          loadError: "Failed to load data",
          retry: "Retry",
          search: "Search…",
          step1: "Target",
          step2: "Scope",
          step3: "Rules",
          rulesHint: "Enabled generation techniques — read-only",
          techniques: ["EP", "BVA", "Negative", "Decision tables", "Localisation"],
        };

  const stateLabel = (s: string) =>
    lang === "ar"
      ? ({ queued: "في الانتظار", running: "قيد التنفيذ", completed: "مكتمل", aborted: "مُجهض", cancelled: "ملغى", failed: "فاشل" } as Record<string, string>)[s] ?? s
      : s;

  const [envs, setEnvs] = useState<any[]>([]);
  const [approved, setApproved] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [envId, setEnvId] = useState("");
  const [subset, setSubset] = useState<Set<string>>(new Set());
  const [subsetOpen, setSubsetOpen] = useState(false);
  const [subsetQ, setSubsetQ] = useState("");

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [live, setLive] = useState<any | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function loadRuns() {
    const r = await api(`/projects/${id}/runs`);
    setRuns(asList(r));
  }

  function loadAll() {
    setLoading(true);
    setError(null);
    return Promise.all([
      api(`/projects/${id}/environments`),
      api(`/projects/${id}/test-cases?state=approved`),
      api(`/projects/${id}/runs`),
    ])
      .then(([e, c, r]) => {
        const el = asList(e);
        setEnvs(el);
        setApproved(asList(c));
        setRuns(asList(r));
        if (el.length > 0) setEnvId((prev) => prev || el[0].id);
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // live polling every 1.5s
  useEffect(() => {
    if (!liveRunId) return;
    let stopped = false;
    let timer: any = null;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await api(`/runs/${liveRunId}`);
        if (stopped) return;
        setLive(r);
        if (TERMINAL.includes(r?.state)) {
          stopped = true;
          if (timer) clearInterval(timer);
          loadRuns().catch(() => {});
          return;
        }
      } catch {
        /* keep polling */
      }
    };
    tick();
    timer = setInterval(tick, 1500);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRunId]);

  async function launch() {
    setLaunchError(null);
    setLaunching(true);
    try {
      const body: any = { environment_id: envId };
      if (subset.size > 0) body.test_case_ids = [...subset];
      const res = await api(`/projects/${id}/runs`, { body });
      setLive(null);
      setLiveRunId(res.run_id ?? res.id);
      await loadRuns().catch(() => {});
    } catch (e: any) {
      setLaunchError(e?.message || String(e));
    } finally {
      setLaunching(false);
    }
  }

  async function cancelRun() {
    if (!liveRunId) return;
    setCancelling(true);
    try {
      await api(`/runs/${liveRunId}/cancel`, { method: "POST", body: {} });
    } catch (e: any) {
      setLaunchError(e?.message || String(e));
    } finally {
      setCancelling(false);
    }
  }

  const counts = live?.counts ?? {};
  const liveTerminal = live && TERMINAL.includes(live.state);
  const subsetFiltered = useMemo(
    () =>
      subsetQ.trim()
        ? approved.filter((c) => (c.title ?? "").toLowerCase().includes(subsetQ.trim().toLowerCase()))
        : approved,
    [approved, subsetQ]
  );

  const countChips: [string, any, string][] = [
    [L.total, counts.total ?? approved.length, "var(--text)"],
    [L.passed, counts.passed ?? 0, "var(--success)"],
    [L.failed, counts.failed ?? 0, "var(--error)"],
    [L.errored, counts.errored ?? 0, "var(--warning)"],
    [L.skipped, counts.skipped ?? 0, "var(--text-muted)"],
  ];

  return (
    <div data-testid="runs-page-root" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={L.title} sub={L.sub} testId="runs-page-header" />

      {error && (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ color: "var(--error)", fontSize: 13 }}>
            {L.loadError} — {error}
          </div>
          <Button variant="secondary" size="sm" onClick={() => loadAll()}>
            {L.retry}
          </Button>
        </div>
      )}

      {/* Launch card */}
      <Card title={L.launch}>
        {loading ? (
          <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* 01 · target */}
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <NumberedChip n="01" color="#FF8A22" />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{L.step1}</div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div style={{ minWidth: 240 }}>
                    <Field label={L.env}>
                      <Select testId="runs-launch-env-select" value={envId} onChange={(e: any) => setEnvId(e.target.value)}>
                        <option value="">{L.pickEnv}</option>
                        {envs.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  {envId && (
                    <div style={{ paddingBottom: 12 }}>
                      <M style={{ fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                        {envs.find((e) => e.id === envId)?.base_url ?? ""}
                      </M>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 02 · scope */}
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start", borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <NumberedChip n="02" color="#9B6BFF" />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{L.step2}</div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
                    <M style={{ fontSize: 20, fontWeight: 700, color: "var(--success)" }}>{approved.length}</M>
                    <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{L.approvedCount}</span>
                  </span>
                  {canDo("trigger_run") && (
                    <Button variant="secondary" size="sm" testId="runs-launch-subset-button" onClick={() => setSubsetOpen(true)} disabled={approved.length === 0}>
                      {L.subset}
                    </Button>
                  )}
                  {subset.size > 0 && (
                    <Badge tone="accent">
                      <M style={{ fontSize: 11 }}>{subset.size}</M> {L.subsetPicked}
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* 03 · rules */}
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start", borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <NumberedChip n="03" color="#2BD4C4" />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{L.step3}</div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    {L.techniques.map((tName) => (
                      <span
                        key={tName}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          height: 22,
                          padding: "0 10px",
                          borderRadius: 6,
                          background: "var(--surface-2)",
                          border: "1px solid var(--border)",
                          fontFamily: "'JetBrains Mono','IBM Plex Sans Arabic',ui-monospace,monospace",
                          fontSize: 10.5,
                          fontWeight: 500,
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {tName}
                      </span>
                    ))}
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{L.rulesHint}</span>
                </div>
              </div>
            </div>

            {/* launch */}
            {canDo("trigger_run") && (
            <div style={{ display: "flex", justifyContent: "flex-end", borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <Button
                testId="runs-launch-run-button"
                disabled={launching || !envId || approved.length === 0 || (!!live && !liveTerminal)}
                onClick={launch}
              >
                {launching ? L.launching : `${L.run} ▶`}
              </Button>
            </div>
            )}

            {envs.length === 0 && <div style={{ fontSize: 13, color: "var(--warning)" }}>{L.noEnvs}</div>}
            {approved.length === 0 && <div style={{ fontSize: 13, color: "var(--warning)" }}>{L.noApproved}</div>}
            {launchError && <div style={{ fontSize: 13, color: "var(--error)" }}>{launchError}</div>}

            {/* Live panel */}
            {liveRunId && live && (
              <div
                data-testid="runs-live-panel"
                style={{
                  border: `1px solid ${liveTerminal ? "var(--border-strong)" : "var(--accent)"}`,
                  background: "var(--surface-2)",
                  borderRadius: 14,
                  padding: "14px 18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{L.live}</span>
                  <M style={{ color: "var(--text-muted)" }}>{shortId(liveRunId)}</M>
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <StatusDot state={live.state} testId="runs-live-status-dot" />
                    <Badge tone={stateTone(live.state)} testId="runs-live-state-badge" state={live.state}>{stateLabel(live.state)}</Badge>
                  </span>
                  <div style={{ marginInlineStart: "auto", display: "flex", gap: 8 }}>
                    {!liveTerminal ? (
                      canDo("trigger_run") && (
                        <Button variant="danger" size="sm" testId="runs-live-cancel-button" disabled={cancelling} onClick={cancelRun}>
                          {L.cancel}
                        </Button>
                      )
                    ) : (
                      <Link href={`/projects/${id}/runs/${liveRunId}`}>
                        <Button variant="secondary" size="sm" testId="runs-live-report-button">
                          {L.report} ←
                        </Button>
                      </Link>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {countChips.map(([label, val, color]) => (
                    <span
                      key={label as string}
                      style={{
                        display: "inline-flex",
                        gap: 8,
                        alignItems: "baseline",
                        border: "1px solid var(--border)",
                        borderRadius: 999,
                        padding: "4px 12px",
                        background: "var(--bg)",
                      }}
                    >
                      <M style={{ fontWeight: 700, color: color as string }}>{val}</M>
                      <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{label}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* History */}
      <Card title={L.history} pad={false}>
        {loading ? (
          <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>…</div>
        ) : runs.length === 0 ? (
          <Empty title={L.noRuns} hint={L.noRunsHint} testId="runs-empty-state" />
        ) : (
          <Table head={[L.runId, L.state, L.counts, L.started, L.finished, L.initiator]} testId="runs-table-root">
            {runs.map((r) => {
              const c = r.counts ?? {};
              return (
                <tr key={r.id} data-testid="runs-row">
                  <td>
                    <Link href={`/projects/${id}/runs/${r.id}`} data-testid="runs-row-link" style={{ textDecoration: "none" }}>
                      <M style={{ color: "var(--accent)" }}>{r.display_id ? `#${r.display_id}` : shortId(r.id)}</M>
                    </Link>
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <StatusDot state={r.state} testId="runs-row-status-dot" />
                      <Badge tone={stateTone(r.state)} testId="runs-row-state-badge" state={r.state}>{stateLabel(r.state)}</Badge>
                    </span>
                  </td>
                  <td>
                    <M>
                      <span style={{ color: "var(--success)" }}>{c.passed ?? 0}</span>
                      {" / "}
                      <span style={{ color: "var(--error)" }}>{c.failed ?? 0}</span>
                      {" / "}
                      <span style={{ color: "var(--warning)" }}>{c.errored ?? 0}</span>
                    </M>
                  </td>
                  <td>
                    <DateTimeText value={r.started_at ?? r.created_at} style={{ color: "var(--text-secondary)" }} />
                  </td>
                  <td>
                    <DateTimeText value={r.finished_at} style={{ color: "var(--text-secondary)" }} />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {r.initiator?.name ?? r.initiated_by_name ?? r.initiated_by ?? r.created_by ?? "—"}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {/* Subset modal */}
      <Modal open={subsetOpen} onClose={() => setSubsetOpen(false)} title={L.subsetTitle} testId="runs-subset-modal">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{L.subsetHint}</div>
          <Input placeholder={L.search} testId="runs-subset-search-input" value={subsetQ} onChange={(e: any) => setSubsetQ(e.target.value)} />
          <div style={{ maxHeight: "40vh", overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
            {subsetFiltered.map((c, i) => (
              <label
                key={c.id}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "8px 12px",
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={subset.has(c.id)}
                  onChange={() =>
                    setSubset((prev) => {
                      const n = new Set(prev);
                      if (n.has(c.id)) n.delete(c.id);
                      else n.add(c.id);
                      return n;
                    })
                  }
                  style={{ marginTop: 3, accentColor: "var(--accent)" }}
                />
                <span style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>{c.title}</span>
              </label>
            ))}
            {subsetFiltered.length === 0 && (
              <div style={{ padding: 16, fontSize: 13, color: "var(--text-muted)" }}>—</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" testId="runs-subset-clear-button" onClick={() => setSubset(new Set())}>
              {L.clear}
            </Button>
            <Button variant="primary" testId="runs-subset-apply-button" onClick={() => setSubsetOpen(false)}>
              {L.apply}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
