"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { API, ApiError, api, getToken, pollJob } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { useProject } from "@/lib/project-context";
import { TEST_TYPES, TEST_TYPE_META, projectTestTypes, type TestType } from "@/lib/test-types";
import { TestTypePicker } from "@/components/test-type-picker";
import {
  Badge,
  Button,
  Card,
  DateTimeText,
  Empty,
  Field,
  Input,
  PageHeader,
  Progress,
  Select,
  StatCard,
} from "@/components/ui";

/**
 * Web target — point Traceo at a URL and pick test types.
 *
 * The page never parses the target itself: a browser sidecar renders it (the
 * demo targets are client-rendered SPAs, so a server-side HTML fetch discovers
 * nothing) and the backend persists what it found. This screen is therefore
 * three things: the launcher (URL + viewport + the five test types), the job
 * result, and the DESIGN box — the screenshot, the extracted palette and the
 * WCAG contrast findings with the suggested passing colour.
 */

// ---------- small helpers ----------

// Forwards every remaining attribute to the span: callers attach data-testid to
// <M> (the palette share and the contrast ratio do), and a signature that named
// only children/style would silently swallow them — TypeScript does not flag a
// hyphenated JSX prop, so the loss is invisible until a selector misses.
function M({
  children,
  style,
  ...rest
}: { children: ReactNode; style?: CSSProperties } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      style={{ fontFamily: "'JetBrains Mono',ui-monospace,monospace", fontSize: 12, ...style }}
    >
      {children}
    </span>
  );
}

function asList(x: any): any[] {
  if (Array.isArray(x)) return x;
  return x?.web_targets ?? x?.items ?? x?.results ?? [];
}

function jobPct(j: any): number {
  const p = Number(j?.progress ?? 0);
  if (!isFinite(p) || p <= 0) return 0;
  return Math.min(100, Math.round(p <= 1 ? p * 100 : p));
}

/** Normalises a colour written as "#RRGGBB", "RRGGBB", [r,g,b] or {hex|colour}. */
function toHex(v: any): string | null {
  if (typeof v === "string") {
    const s = v.trim().replace(/^#/, "");
    return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toUpperCase()}` : null;
  }
  if (Array.isArray(v) && v.length >= 3) {
    const [r, g, b] = v.slice(0, 3).map((n: any) => {
      const x = Math.round(Number(n));
      return Number.isFinite(x) ? Math.max(0, Math.min(255, x)) : 0;
    });
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  }
  if (v && typeof v === "object") {
    return toHex(v.hex ?? v.colour ?? v.color ?? v.rgb ?? null);
  }
  return null;
}

/** Share as a 0..1 fraction — accepts a fraction or an already-multiplied percentage. */
function toShare(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? Math.min(1, n / 100) : n;
}

function toNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: any): boolean | null {
  return typeof v === "boolean" ? v : null;
}

// ---------- design payload normalisation ----------
//
// The detail response carries the design box either as ready-made
// palette/contrast arrays or as the raw `design_facts` list (kind "surface"
// with {colour, share}, kind "contrast" with subject "#INK_on_#SURFACE" and
// {ratio, passes_aa}). Both are read here so the screen renders whichever the
// backend hands over, and never invents a colour it was not given.

type PaletteEntry = { hex: string; share: number };

type ContrastFinding = {
  factId: string | null;
  ink: string;
  surface: string;
  ratio: number | null;
  passes: boolean | null;
  suggested: string | null;
  ratioAfter: number | null;
  achievable: boolean | null;
};

function factsOf(detail: any): any[] {
  const f = detail?.design?.facts ?? detail?.design_facts ?? detail?.facts;
  return Array.isArray(f) ? f : [];
}

function readPalette(detail: any): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const direct = detail?.design?.palette ?? detail?.palette;
  if (Array.isArray(direct)) {
    for (const e of direct) {
      const hex = toHex(e?.hex ?? e?.colour ?? e?.color ?? e);
      if (!hex) continue;
      out.push({ hex, share: toShare(e?.share ?? e?.value?.share) });
    }
  }
  if (out.length === 0) {
    for (const f of factsOf(detail)) {
      if (f?.kind !== "surface") continue;
      const hex = toHex(f?.subject ?? f?.value?.colour);
      if (!hex) continue;
      out.push({ hex, share: toShare(f?.value?.share) });
    }
  }
  return out.sort((a, b) => b.share - a.share);
}

/** Splits a contrast fact subject ("#111111_on_#FFFFFF") into its two colours. */
function splitSubject(subject: any): [string | null, string | null] {
  if (typeof subject !== "string") return [null, null];
  const parts = subject.split("_on_");
  if (parts.length !== 2) return [null, null];
  return [toHex(parts[0]), toHex(parts[1])];
}

function readContrast(detail: any): ContrastFinding[] {
  const rows: ContrastFinding[] = [];

  const push = (raw: any, fallbackInk: any, fallbackSurface: any, factId: string | null) => {
    const ink = toHex(raw?.ink ?? raw?.foreground ?? raw?.fg ?? raw?.text ?? fallbackInk);
    const surface = toHex(
      raw?.surface ?? raw?.on_surface ?? raw?.background ?? raw?.bg ?? fallbackSurface
    );
    if (!ink || !surface) return;
    const remedy = raw?.remedy ?? raw?.suggestion ?? raw?.nearest_accessible ?? raw;
    const suggested = toHex(remedy?.suggested ?? remedy?.suggested_hex ?? remedy?.hex ?? null);
    rows.push({
      factId,
      ink,
      surface,
      ratio: toNum(raw?.ratio ?? raw?.contrast ?? raw?.value?.ratio ?? raw?.ratio_before),
      passes: toBool(raw?.passes_aa ?? raw?.passes ?? raw?.value?.passes_aa),
      suggested,
      ratioAfter: toNum(remedy?.ratio_after ?? remedy?.ratio ?? null),
      achievable: toBool(remedy?.achievable),
    });
  };

  const direct = detail?.design?.contrast ?? detail?.contrast ?? detail?.design?.contrast_findings;
  if (Array.isArray(direct)) {
    for (const raw of direct) {
      const [ink, surface] = splitSubject(raw?.subject);
      push(raw, ink, surface, typeof raw?.id === "string" ? raw.id : null);
    }
  }

  if (rows.length === 0) {
    for (const f of factsOf(detail)) {
      if (f?.kind !== "contrast") continue;
      const [ink, surface] = splitSubject(f?.subject);
      const raw = { ...(f?.value ?? {}), ...(f?.remedy ? { remedy: f.remedy } : {}) };
      push(
        raw,
        ink,
        surface,
        typeof f?.id === "string" ? f.id : f?.subject ? `contrast:${f.subject}` : null
      );
    }
  }

  // Worst contrast first — the failing inks are what a designer needs to see.
  return rows.sort((a, b) => (a.ratio ?? 99) - (b.ratio ?? 99));
}

/** Counts for a stored target, from an `inventory`/`summary` block or the root. */
function readCounts(detail: any): { key: string; label: string; value: number }[] {
  const inv = detail?.inventory ?? detail?.summary ?? detail ?? {};
  const keys: [string, string][] = [
    ["forms", "Forms"],
    ["controls", "Controls"],
    ["requests", "Requests"],
    ["endpoints", "Endpoints"],
    ["requirements", "Requirements"],
    ["cases", "Cases"],
    ["console_errors", "Console errors"],
  ];
  const out: { key: string; label: string; value: number }[] = [];
  for (const [k, label] of keys) {
    const v = inv?.[k] ?? detail?.[k];
    const n = Array.isArray(v) ? v.length : toNum(v);
    if (n === null) continue;
    out.push({ key: k, label, value: n });
  }
  return out;
}

function targetOf(detail: any): any {
  return detail?.web_target ?? detail?.target ?? detail ?? {};
}

// ---------- the five test types ----------
// The vocabulary, the descriptions and the control all come from one place, so
// this screen and the project's own declaration can never disagree about what
// the five types are.

const VIEWPORTS = ["1280x800", "1440x900", "1920x1080", "1024x768", "390x844"];

export default function TargetPage() {
  const { id } = useParams<{ id: string }>();
  const canDo = useCan();

  const L = {
    title: "Target",
    sub: "Point Traceo at a URL: a real browser renders it, and the test types you pick are built from what it actually found",
    launcher: "Web target",
    urlLabel: "Page URL",
    urlHint: "The page is rendered in a browser — client-rendered SPAs are discovered exactly like server-rendered pages.",
    urlPh: "https://example.com/login",
    viewportLabel: "Viewport",
    types: "Test types",
    typesHint: "Each type only builds from what discovery found — nothing is invented.",
    start: "Start discovery",
    starting: "Discovering…",
    grounding:
      "Every case references something discovery actually found: a form field selector, a captured request, or a design fact id.",
    result: "Discovery result",
    skipped: "Skipped",
    casesByType: "Cases by type",
    duplicateOne: "case already existed from an earlier run and was not written again",
    duplicateMany: "cases already existed from an earlier run and were not written again",
    discardedOne: "case was discarded for citing something discovery did not find",
    discardedMany: "cases were discarded for citing something discovery did not find",
    toRequirements: "Requirements",
    toEndpoints: "Endpoints",
    toReview: "Review",
    targets: "Discovered targets",
    empty: "No web target yet",
    emptyHint: "Enter a URL above and start discovery — the browser sidecar renders the page and reads it",
    emptyView: "Enter a URL and start discovery to fill this page",
    loadError: "Failed to load web targets",
    detailError: "Failed to load this target",
    retry: "Retry",
    select: "View",
    design: "Design",
    designSub: "Extracted from the captured screenshot — the palette by screen share and every ink's WCAG contrast",
    screenshot: "Screenshot",
    noScreenshot: "No screenshot stored for this target",
    palette: "Palette",
    noPalette: "No palette facts — run discovery with the UI type selected",
    contrast: "Contrast findings",
    noContrast: "No contrast facts — run discovery with the UI type selected",
    share: "share",
    ratio: "Ratio",
    pass: "AA pass",
    fail: "AA fail",
    suggested: "Suggested",
    unachievable: "Unreachable on this surface — the surface has to change, not the ink",
    noneChecked: "Pick at least one test type",
    badUrl: "Enter an absolute http:// or https:// URL",
  };

  // ---- launcher state ----
  const [url, setUrl] = useState("");
  const [viewport, setViewport] = useState(VIEWPORTS[0]);
  // The project's declaration is the default AND the ceiling: the backend
  // refuses a type the project is not set up for, so offering it here would be
  // offering a control that always fails.
  const { project } = useProject();
  const declaredTypes = projectTestTypes(project);
  const [types, setTypes] = useState<Set<TestType> | null>(null);
  const selected = types ?? new Set<TestType>(declaredTypes);
  const [job, setJob] = useState<{ msg: string; pct: number } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startErrorCode, setStartErrorCode] = useState<string | null>(null);
  const [startErrorList, setStartErrorList] = useState<string[]>([]);
  const [result, setResult] = useState<any | null>(null);

  // ---- stored targets ----
  const [targets, setTargets] = useState<any[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ---- selected target detail + screenshot ----
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const shotRef = useRef<string | null>(null);

  const loadTargets = useCallback(async () => {
    const r = await api(`/projects/${id}/web-targets`);
    const list = asList(r);
    setTargets(list);
    setSelectedId((prev) => prev ?? (list.length > 0 ? list[0]?.id ?? null : null));
  }, [id]);

  useEffect(() => {
    let alive = true;
    setListLoading(true);
    setListError(null);
    loadTargets()
      .catch((e) => alive && setListError(e?.message || String(e)))
      .finally(() => alive && setListLoading(false));
    return () => {
      alive = false;
    };
  }, [loadTargets]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    setDetailError(null);
    api(`/web-targets/${selectedId}`)
      .then((d) => alive && setDetail(d ?? null))
      .catch((e) => alive && setDetailError(e?.message || String(e)))
      .finally(() => alive && setDetailLoading(false));
    return () => {
      alive = false;
    };
  }, [selectedId]);

  // The screenshot route is authenticated, so it cannot be an <img src> — it is
  // fetched with the bearer token and handed to the <img> as an object URL.
  useEffect(() => {
    if (!selectedId) {
      setShot(null);
      setShotError(null);
      return;
    }
    let alive = true;
    setShotError(null);
    const token = getToken();
    fetch(`${API}/web-targets/${selectedId}/screenshot`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (!alive) return;
        const next = URL.createObjectURL(blob);
        if (shotRef.current) URL.revokeObjectURL(shotRef.current);
        shotRef.current = next;
        setShot(next);
      })
      .catch((e) => {
        if (!alive) return;
        setShot(null);
        setShotError(e?.message || String(e));
      });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  useEffect(
    () => () => {
      if (shotRef.current) URL.revokeObjectURL(shotRef.current);
      shotRef.current = null;
    },
    []
  );

  function toggleType(t: TestType) {
    // A type the project excluded is not selectable, so it can never enter the
    // set — the picker disables it and this guard makes that true of the state
    // as well, not only of the control.
    if (!declaredTypes.includes(t)) return;
    setTypes((prev) => {
      const n = new Set(prev ?? declaredTypes);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  }

  const trimmed = url.trim();
  const urlOk = /^https?:\/\/\S+$/i.test(trimmed);
  const canStart = urlOk && selected.size > 0 && !job;

  async function start() {
    setStartError(null);
    setStartErrorCode(null);
    setStartErrorList([]);
    setResult(null);
    setJob({ msg: L.starting, pct: 2 });
    try {
      const res = await api(`/projects/${id}/web-targets`, {
        body: {
          url: trimmed,
          viewport,
          // Sent in the canonical order so the request is stable to read.
          test_types: TEST_TYPES.filter((t) => selected.has(t)),
        },
      });
      const out = await pollJob(res.job_id, (j) =>
        setJob({ msg: j?.message || L.starting, pct: jobPct(j) })
      );
      setResult(out ?? {});
      const newId = out?.target_id ?? out?.web_target_id ?? null;
      await loadTargets().catch(() => undefined);
      if (newId) setSelectedId(String(newId));
    } catch (e: any) {
      setStartError(e?.message || String(e));
      if (e instanceof ApiError) {
        setStartErrorCode(e.code || null);
        setStartErrorList(e.errors);
      }
    } finally {
      setJob(null);
    }
  }

  const palette = readPalette(detail);
  const contrast = readContrast(detail);
  const counts = readCounts(detail);
  const t = targetOf(detail);
  const skipped: any[] = Array.isArray(result?.skipped) ? result.skipped : [];
  const casesByType: Record<string, any> =
    result?.cases_by_type && typeof result.cases_by_type === "object" ? result.cases_by_type : {};
  const duplicateCount = toNum(result?.duplicates) ?? 0;
  const discardedCount = toNum(result?.discarded) ?? 0;

  const resultStats: [string, string][] = [
    ["forms", "Forms"],
    ["controls", "Controls"],
    ["requests", "Requests"],
    ["endpoints", "Endpoints"],
    ["requirements", "Requirements"],
  ];

  return (
    <div data-testid="target-page-root" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={L.title} sub={L.sub} testId="target-page-header" />

      {/* ---------- launcher ---------- */}
      {canDo("import_spec") && (
        <Card title={L.launcher} testId="target-form-card">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 300 }}>
                <Field label={L.urlLabel} hint={L.urlHint} testId="target-url-input">
                  <Input
                    type="url"
                    inputMode="url"
                    placeholder={L.urlPh}
                    value={url}
                    onChange={(e: any) => setUrl(e.target.value)}
                    style={{ fontFamily: "'JetBrains Mono',ui-monospace,monospace", fontSize: 12 }}
                  />
                </Field>
              </div>
              <div style={{ width: 180 }}>
                <Field label={L.viewportLabel} testId="target-viewport-select">
                  <Select value={viewport} onChange={(e: any) => setViewport(e.target.value)}>
                    {VIEWPORTS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>

            <div>
              <div
                className="eyebrow"
                style={{ fontSize: 10.5, color: "var(--text-secondary)", marginBottom: 4 }}
              >
                {L.types}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>
                {L.typesHint}
              </div>
              <TestTypePicker
                selected={TEST_TYPES.filter((t) => selected.has(t))}
                onToggle={toggleType}
                testIdPrefix="target-type"
                description="hint"
                limitTo={declaredTypes}
              />
              {declaredTypes.length < TEST_TYPES.length && (
                <div
                  data-testid="target-types-scope-hint"
                  style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}
                >
                  Greyed-out types are off for this project. Change them on Overview.
                </div>
              )}
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
              {L.grounding}
            </div>

            {job ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
                <div style={{ fontSize: 13, color: "var(--text)" }}>{job.msg}</div>
                <Progress pct={job.pct} tone="accent" label="Web discovery progress" testId="target-job-progress" />
                <M style={{ color: "var(--text-secondary)" }}>{job.pct}%</M>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <Button disabled={!canStart} onClick={start} testId="target-start-button">
                  {L.start}
                </Button>
                {trimmed !== "" && !urlOk && (
                  <span style={{ fontSize: 12, color: "var(--warning)" }} data-testid="target-url-hint">
                    {L.badUrl}
                  </span>
                )}
                {selected.size === 0 && (
                  <span style={{ fontSize: 12, color: "var(--warning)" }} data-testid="target-types-hint">
                    {L.noneChecked}
                  </span>
                )}
              </div>
            )}

            {startError && (
              <div
                data-testid="target-start-error"
                data-state={startErrorCode ?? undefined}
                style={{
                  border: "1px solid var(--error)",
                  background: "var(--error-subtle, rgba(255,92,114,.12))",
                  borderRadius: 12,
                  padding: "10px 14px",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--error)" }}>{startError}</div>
                {startErrorCode && (
                  <M style={{ fontSize: 11, color: "var(--text-secondary)" }}>{startErrorCode}</M>
                )}
                {startErrorList.length > 0 && (
                  <ul
                    data-testid="target-start-error-list"
                    style={{ margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    {startErrorList.map((msg, i) => (
                      <li key={i} data-testid="target-start-error-item">
                        <M style={{ fontSize: 11, color: "var(--text-secondary)" }}>{msg}</M>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ---------- job result ---------- */}
      {result && (
        <Card title={L.result} testId="target-result-card">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {result.title && (
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }} data-testid="target-result-title">
                {result.title}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
              {resultStats.map(([k, label]) => (
                <StatCard
                  key={k}
                  value={toNum(result[k]) ?? 0}
                  label={label}
                  testId={`target-result-${k}-stat`}
                />
              ))}
            </div>

            {Object.keys(casesByType).length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{L.casesByType}:</span>
                {Object.entries(casesByType).map(([k, v]) => (
                  <span key={k} data-testid="target-result-cases-badge" data-state={k}>
                    <Badge tone="accent">
                      {k} <M style={{ fontSize: 11 }}>{toNum(v) ?? 0}</M>
                    </Badge>
                  </span>
                ))}
              </div>
            )}

            {/* A re-run of the same page rebuilds the same cases, so the counts
                above are new cases only. Without this line a second run reads
                as "nothing was found" when in fact nothing had changed. */}
            {(duplicateCount > 0 || discardedCount > 0) && (
              <div
                data-testid="target-result-repeat-note"
                style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}
              >
                {duplicateCount > 0 && (
                  <span data-testid="target-result-duplicates">
                    {duplicateCount} {duplicateCount === 1 ? L.duplicateOne : L.duplicateMany}
                  </span>
                )}
                {duplicateCount > 0 && discardedCount > 0 && " · "}
                {discardedCount > 0 && (
                  <span data-testid="target-result-discarded">
                    {discardedCount} {discardedCount === 1 ? L.discardedOne : L.discardedMany}
                  </span>
                )}
              </div>
            )}

            {skipped.length > 0 && (
              <div
                data-testid="target-result-skipped"
                style={{
                  border: "1px solid var(--warning)",
                  background: "var(--warning-subtle, rgba(255,197,61,.16))",
                  borderRadius: 12,
                  padding: "10px 14px",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--warning)", marginBottom: 6 }}>
                  {L.skipped} ({skipped.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {skipped.map((s, i) => (
                    <div
                      key={i}
                      data-testid="target-result-skipped-row"
                      data-state={typeof s?.type === "string" ? s.type : undefined}
                      style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}
                    >
                      <M style={{ color: "var(--warning)" }}>{s?.type ?? "—"}</M>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        {s?.reason ?? (typeof s === "string" ? s : JSON.stringify(s))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link href={`/projects/${id}/requirements`}>
                <Button variant="secondary" size="sm" testId="target-to-requirements-button">
                  {L.toRequirements} →
                </Button>
              </Link>
              <Link href={`/projects/${id}/endpoints`}>
                <Button variant="secondary" size="sm" testId="target-to-endpoints-button">
                  {L.toEndpoints} →
                </Button>
              </Link>
              <Link href={`/projects/${id}/review`}>
                <Button variant="secondary" size="sm" testId="target-to-review-button">
                  {L.toReview} →
                </Button>
              </Link>
            </div>
          </div>
        </Card>
      )}

      {/* ---------- stored targets ---------- */}
      <Card title={`${L.targets}${targets.length ? ` (${targets.length})` : ""}`} testId="target-list-card">
        {listLoading ? (
          <div style={{ padding: 12, color: "var(--text-secondary)", fontSize: 13 }}>…</div>
        ) : listError ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <div style={{ color: "var(--error)", fontSize: 13 }} data-testid="target-list-error">
              {L.loadError} — {listError}
            </div>
            <Button
              variant="secondary"
              size="sm"
              testId="target-list-retry-button"
              onClick={() => {
                setListError(null);
                setListLoading(true);
                loadTargets()
                  .catch((e) => setListError(e?.message || String(e)))
                  .finally(() => setListLoading(false));
              }}
            >
              {L.retry}
            </Button>
          </div>
        ) : targets.length === 0 ? (
          <Empty
            title={L.empty}
            hint={canDo("import_spec") ? L.emptyHint : L.emptyView}
            testId="target-empty-state"
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {targets.map((row, i) => {
              const active = row.id === selectedId;
              return (
                <div
                  key={row.id ?? i}
                  data-testid="target-list-row"
                  data-state={typeof row.status === "string" ? row.status : undefined}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                    padding: "10px 4px",
                    borderTop: i === 0 ? "none" : "1px solid var(--border)",
                    background: active ? "var(--accent-subtle)" : undefined,
                  }}
                >
                  <Badge
                    tone={row.status === "discovered" ? "success" : row.status === "failed" ? "error" : "info"}
                    state={row.status}
                    testId="target-list-status-badge"
                  >
                    {row.status ?? "—"}
                  </Badge>
                  <M style={{ color: "var(--text)", overflowWrap: "anywhere", flex: 1, minWidth: 220 }}>
                    {row.url}
                  </M>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{row.title ?? "—"}</span>
                  <M style={{ fontSize: 11, color: "var(--text-secondary)" }}>{row.viewport ?? "—"}</M>
                  <DateTimeText value={row.last_discovered_at} style={{ color: "var(--text-secondary)" }} />
                  <Button
                    variant={active ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setSelectedId(row.id)}
                    testId="target-list-select-button"
                  >
                    {L.select}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ---------- inventory of the selected target ---------- */}
      {selectedId && counts.length > 0 && (
        <Card title={t.title || t.url || L.targets} testId="target-detail-card">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <M style={{ color: "var(--accent)", overflowWrap: "anywhere" }}>{t.final_url || t.url}</M>
              {t.viewport && <Badge tone="muted">{t.viewport}</Badge>}
              {t.status && (
                <Badge
                  tone={t.status === "discovered" ? "success" : t.status === "failed" ? "error" : "info"}
                  state={t.status}
                  testId="target-detail-status-badge"
                >
                  {t.status}
                </Badge>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
              {counts.map((c) => (
                <StatCard key={c.key} value={c.value} label={c.label} testId={`target-detail-${c.key}-stat`} />
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* ---------- DESIGN ---------- */}
      <Card title={L.design} testId="target-design-section">
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 14, lineHeight: 1.6 }}>
          {L.designSub}
        </div>

        {!selectedId ? (
          <Empty title={L.empty} hint={canDo("import_spec") ? L.emptyHint : L.emptyView} testId="target-design-empty" />
        ) : detailLoading ? (
          <div style={{ padding: 12, color: "var(--text-secondary)", fontSize: 13 }}>…</div>
        ) : detailError ? (
          <div style={{ color: "var(--error)", fontSize: 13 }} data-testid="target-design-error">
            {L.detailError} — {detailError}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
            {/* screenshot */}
            <div style={{ flex: "1 1 380px", minWidth: 280 }}>
              <div className="eyebrow" style={{ fontSize: 10.5, color: "var(--text-secondary)", marginBottom: 8 }}>
                {L.screenshot}
              </div>
              {shot ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={shot}
                  alt={`Rendered screenshot of ${t.final_url || t.url || "the web target"}`}
                  data-testid="target-design-screenshot"
                  style={{
                    display: "block",
                    width: "100%",
                    maxHeight: 460,
                    objectFit: "contain",
                    objectPosition: "top",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    background: "var(--bg)",
                  }}
                />
              ) : (
                <div
                  data-testid="target-design-screenshot-missing"
                  style={{
                    border: "1px dashed var(--border-strong)",
                    borderRadius: 12,
                    padding: "24px 16px",
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    textAlign: "center",
                  }}
                >
                  {L.noScreenshot}
                  {shotError && <M style={{ display: "block", marginTop: 6, fontSize: 11 }}>{shotError}</M>}
                </div>
              )}
            </div>

            {/* palette + contrast */}
            <div style={{ flex: "1 1 380px", minWidth: 280, display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <div className="eyebrow" style={{ fontSize: 10.5, color: "var(--text-secondary)", marginBottom: 8 }}>
                  {L.palette}
                </div>
                {palette.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }} data-testid="target-design-palette-empty">
                    {L.noPalette}
                  </div>
                ) : (
                  <div data-testid="target-design-palette" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {palette.map((p) => (
                      <div
                        key={p.hex}
                        data-testid="target-design-palette-swatch"
                        data-colour={p.hex}
                        style={{ display: "flex", gap: 10, alignItems: "center" }}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 8,
                            flexShrink: 0,
                            background: p.hex,
                            border: "1px solid var(--border-strong)",
                          }}
                        />
                        <M style={{ color: "var(--text)", minWidth: 74 }}>{p.hex}</M>
                        <div style={{ flex: 1, minWidth: 60 }}>
                          <Progress
                            pct={p.share * 100}
                            tone="accent"
                            label={`Screen share of ${p.hex}`}
                          />
                        </div>
                        <M
                          data-testid="target-design-palette-share"
                          style={{ fontSize: 11, color: "var(--text-secondary)", minWidth: 62, textAlign: "right" }}
                        >
                          {(p.share * 100).toFixed(2)}% {L.share}
                        </M>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="eyebrow" style={{ fontSize: 10.5, color: "var(--text-secondary)", marginBottom: 8 }}>
                  {L.contrast}
                </div>
                {contrast.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }} data-testid="target-design-contrast-empty">
                    {L.noContrast}
                  </div>
                ) : (
                  <div data-testid="target-design-contrast" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {contrast.map((c, i) => {
                      const passes = c.passes ?? (c.ratio === null ? null : c.ratio >= 4.5);
                      return (
                        <div
                          key={c.factId ?? `${c.ink}_on_${c.surface}_${i}`}
                          data-testid="target-design-contrast-row"
                          data-state={passes === null ? undefined : passes ? "pass" : "fail"}
                          data-fact-id={c.factId ?? undefined}
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                            flexWrap: "wrap",
                            border: "1px solid var(--border)",
                            borderRadius: 12,
                            background: "var(--surface-2)",
                            padding: "8px 12px",
                          }}
                        >
                          <span
                            aria-hidden
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 34,
                              height: 26,
                              borderRadius: 8,
                              flexShrink: 0,
                              background: c.surface,
                              color: c.ink,
                              border: "1px solid var(--border-strong)",
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          >
                            Aa
                          </span>
                          <M style={{ color: "var(--text)" }}>
                            {c.ink} on {c.surface}
                          </M>
                          <M data-testid="target-design-contrast-ratio" style={{ color: "var(--text-secondary)" }}>
                            {L.ratio} {c.ratio === null ? "—" : `${c.ratio.toFixed(2)}:1`}
                          </M>
                          {passes !== null && (
                            <Badge tone={passes ? "success" : "error"} testId="target-design-contrast-badge">
                              {passes ? L.pass : L.fail}
                            </Badge>
                          )}
                          {c.suggested && passes === false && (
                            <span
                              data-testid="target-design-contrast-suggestion"
                              data-colour={c.suggested}
                              style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
                            >
                              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{L.suggested}</span>
                              <span
                                aria-hidden
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  width: 34,
                                  height: 26,
                                  borderRadius: 8,
                                  background: c.surface,
                                  color: c.suggested,
                                  border: "1px solid var(--border-strong)",
                                  fontSize: 12,
                                  fontWeight: 700,
                                }}
                              >
                                Aa
                              </span>
                              <M style={{ color: "var(--success)" }}>{c.suggested}</M>
                              {c.ratioAfter !== null && (
                                <M style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                                  {c.ratioAfter.toFixed(2)}:1
                                </M>
                              )}
                            </span>
                          )}
                          {c.achievable === false && (
                            <span
                              data-testid="target-design-contrast-unachievable"
                              style={{ fontSize: 11, color: "var(--warning)" }}
                            >
                              {L.unachievable}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
