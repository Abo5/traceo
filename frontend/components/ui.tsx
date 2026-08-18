"use client";

import React, { useEffect } from "react";

// ---------- Button ----------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  /** Rendered as data-testid on the <button>. */
  testId?: string;
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  testId,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className ?? ""}`}
      type={props.type ?? "button"}
      data-testid={testId}
      {...props}
    />
  );
}

// ---------- Card ----------

export function Card({
  title,
  action,
  children,
  pad = true,
  className,
  style,
  testId,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  pad?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Rendered as data-testid on the root .card div. */
  testId?: string;
}) {
  return (
    <div className={`card ${className ?? ""}`} style={style} data-testid={testId}>
      {(title !== undefined || action !== undefined) && (
        <div className="card-head">
          {title !== undefined && <div className="card-title">{title}</div>}
          {action !== undefined && <div className="card-action">{action}</div>}
        </div>
      )}
      <div className={pad ? "card-body" : "card-body-flush"}>{children}</div>
    </div>
  );
}

// ---------- Badge ----------

export type BadgeTone = "success" | "warning" | "error" | "info" | "muted" | "accent";

export function Badge({
  tone = "muted",
  children,
  testId,
  state,
}: {
  tone?: BadgeTone;
  children?: React.ReactNode;
  /** Rendered as data-testid on the <span>. */
  testId?: string;
  /** Rendered verbatim as data-state on the <span> (backend state values, no mapping). */
  state?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} data-testid={testId} data-state={state}>
      {children}
    </span>
  );
}

// ---------- Pill ----------

export function Pill({
  active,
  onClick,
  children,
  testId,
  state,
}: {
  active?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  /** Rendered as data-testid on the <button>. */
  testId?: string;
  /** Rendered verbatim as data-state on the <button> (backend state values, no mapping). */
  state?: string;
}) {
  return (
    <button
      type="button"
      className={`pill ${active ? "pill-active" : ""}`}
      onClick={onClick}
      data-testid={testId}
      data-state={state}
    >
      {children}
    </button>
  );
}

// ---------- StatCard ----------

export function StatCard({
  value,
  label,
  color,
  badge,
  hint,
  bar,
  testId,
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  color?: string;
  /** Small pill beside the number (the design's ▲ 16 / 1 high chip). */
  badge?: React.ReactNode;
  /** One line of context under the number. */
  hint?: React.ReactNode;
  /** 0–100: renders the design's meter under the number instead of a hint. */
  bar?: number;
  /** Rendered as data-testid on the root .stat-card div. */
  testId?: string;
}) {
  const pct = bar === undefined ? null : Math.max(0, Math.min(100, bar));
  return (
    <div className="stat-card" data-testid={testId}>
      <div className="klabel">{label}</div>
      <div className="row" style={{ gap: 8, margin: "6px 0 4px" }}>
        <span className="stat-value" style={color ? { color } : undefined}>
          {value}
        </span>
        {badge}
      </div>
      {pct !== null && (
        <div className="bar" style={{ marginBlockStart: 4 }}>
          <i
            className={pct >= 90 ? "ok" : pct >= 60 ? "" : "warn"}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {hint !== undefined && <div className="stat-label">{hint}</div>}
    </div>
  );
}

// ---------- Table ----------

export function Table({
  head,
  children,
  testId,
}: {
  head: React.ReactNode[];
  children?: React.ReactNode;
  /** Rendered as data-testid on the root .table-wrap div. */
  testId?: string;
}) {
  return (
    <div className="table-wrap" data-testid={testId}>
      <table className="table-grid">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// ---------- Progress ----------

const PROGRESS_TONES: Record<string, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--error)",
  info: "var(--info)",
  accent: "var(--accent)",
};

export function Progress({
  pct,
  tone,
  testId,
  label,
}: {
  pct: number;
  tone?: string;
  /** Rendered as data-testid on the root .progress div (role=progressbar). */
  testId?: string;
  /**
   * Accessible name. A role="progressbar" with no name is an axe violation
   * (aria-progressbar-name) and, more to the point, a screen reader announces
   * "progress bar, 40%" with no idea what is 40% done. Callers in a repeated
   * context (a table row) should pass what the bar measures AND which row it
   * belongs to; the generic fallback keeps a bar from ever being nameless.
   */
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const bg = tone ? PROGRESS_TONES[tone] ?? tone : "var(--blue)";
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label ?? "Progress"}
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${clamped}%`}
      data-testid={testId}
    >
      <div className="progress-fill" style={{ width: `${clamped}%`, background: bg }} />
    </div>
  );
}

// ---------- Empty ----------

export function Empty({
  icon,
  title,
  hint,
  action,
  testId,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
  /** Optional call-to-action rendered under the hint (primary next step). */
  action?: React.ReactNode;
  /** Rendered as data-testid on the root .empty div. */
  testId?: string;
}) {
  return (
    <div className="empty" data-testid={testId}>
      <div className="empty-icon" aria-hidden>
        {icon ?? "◌"}
      </div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** Rendered as data-testid on the .modal dialog element (not the overlay). */
  testId?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" data-testid={testId}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---------- Field / Input / Select / Textarea ----------

export function Field({
  label,
  hint,
  children,
  testId,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
  /**
   * Rendered as data-testid on the input itself: when children is a single
   * element (Input/Select/Textarea) it is cloned with data-testid; otherwise
   * the attribute falls back to the root <label>.
   */
  testId?: string;
}) {
  const singleChild = testId && React.isValidElement(children);
  const content = singleChild
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        "data-testid": testId,
      })
    : children;
  return (
    <label className="field" data-testid={testId && !singleChild ? testId : undefined}>
      <span className="field-label">{label}</span>
      {content}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Input(
  props: React.InputHTMLAttributes<HTMLInputElement> & { testId?: string }
) {
  const { className, testId, ...rest } = props;
  return <input className={`input ${className ?? ""}`} data-testid={testId} {...rest} />;
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & { testId?: string }
) {
  const { className, testId, ...rest } = props;
  return <select className={`input select ${className ?? ""}`} data-testid={testId} {...rest} />;
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { testId?: string }
) {
  const { className, testId, ...rest } = props;
  return <textarea className={`input textarea ${className ?? ""}`} data-testid={testId} {...rest} />;
}

// ---------- Mono ----------

export function Mono({
  children,
  className,
  style,
  testId,
}: {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Rendered as data-testid on the <span>. */
  testId?: string;
}) {
  return (
    <span className={`mono ${className ?? ""}`} style={style} data-testid={testId}>
      {children}
    </span>
  );
}

// ---------- StatusDot ----------

export const STATE_TONES: Record<string, BadgeTone> = {
  draft: "muted",
  approved: "success",
  rejected: "error",
  stale: "warning",
  archived: "muted",
  extracted: "info",
  confirmed: "success",
  changed: "warning",
  removed: "error",
  passed: "success",
  failed: "error",
  errored: "warning",
  queued: "info",
  running: "info",
  completed: "success",
  aborted: "error",
  cancelled: "muted",
};

const TONE_COLORS: Record<BadgeTone, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--error)",
  info: "var(--info)",
  muted: "var(--text-muted)",
  accent: "var(--accent)",
};

/** Badge tone for a domain state name (draft/approved/passed/...). */
export function stateTone(state: string): BadgeTone {
  return STATE_TONES[state] ?? "muted";
}

export function StatusDot({
  state,
  testId,
}: {
  state: string;
  /** Rendered as data-testid on the <span>. */
  testId?: string;
}) {
  const tone = stateTone(state);
  return (
    <span
      className="status-dot"
      style={{ background: TONE_COLORS[tone] }}
      title={state}
      data-testid={testId}
      data-state={state}
    />
  );
}

// ---------- DateTimeText ----------

/** Formats an ISO datetime as YYYY-MM-DD HH:mm (stable, locale-independent). */
export function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Mono datetime — fixed width, never wraps. */
export function DateTimeText({
  value,
  style,
  testId,
}: {
  value?: string | null;
  style?: React.CSSProperties;
  /** Rendered as data-testid on the <span>. */
  testId?: string;
}) {
  return (
    <span
      className="mono"
      style={{ fontSize: 11, whiteSpace: "nowrap", ...style }}
      data-testid={testId}
    >
      {fmtDateTime(value)}
    </span>
  );
}

// ---------- RefChip ----------

/** v2 FR-reference chip: mono id like "FR-054" (the design's .refc). */
export function RefChip({
  id,
  testId,
}: {
  id: string;
  /** Rendered as data-testid on the <span>. */
  testId?: string;
}) {
  return (
    <span className="refc" data-testid={testId}>
      {id}
    </span>
  );
}

// ---------- TrendBars ----------

/** Inline gradient bar chart of coverage per run (v2 FR-054). */
export function TrendBars({
  data,
  height = 120,
  testId,
}: {
  data: { display_id?: number | string; coverage_pct?: number }[];
  height?: number;
  /** Rendered as data-testid on the root chart div. */
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 8,
        height,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {data.map((d, i) => {
        const pct = Math.max(0, Math.min(100, Number(d.coverage_pct) || 0));
        return (
          <div
            key={i}
            title={`#${d.display_id ?? i + 1} · ${Math.round(pct)}%`}
            style={{
              flex: 1,
              minWidth: 8,
              maxWidth: 24,
              height: `${Math.max(pct, 3)}%`,
              borderRadius: "3px 3px 0 0",
              background: "linear-gradient(180deg, var(--blue), var(--violet))",
            }}
          />
        );
      })}
    </div>
  );
}

// ---------- Donut ----------

/** SVG donut of run outcomes with pass-rate % centered (v2 latest-run card). */
export function Donut({
  passed,
  failed,
  errored,
  size = 96,
  testId,
}: {
  passed: number;
  failed: number;
  errored: number;
  size?: number;
  /** Rendered as data-testid on the root <svg>. */
  testId?: string;
}) {
  const p = Math.max(0, Number(passed) || 0);
  const f = Math.max(0, Number(failed) || 0);
  const e = Math.max(0, Number(errored) || 0);
  const total = p + f + e;
  const stroke = Math.max(8, Math.round(size / 10));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const rate = total > 0 ? Math.round((p / total) * 100) : 0;
  const segs: [number, string][] = [
    [p, "var(--success)"],
    [f, "var(--error)"],
    [e, "var(--warning)"],
  ];
  let acc = 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${rate}%`}
      data-testid={testId}
    >
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        {total > 0 &&
          segs.map(([v, color], i) => {
            if (v <= 0) return null;
            const len = (v / total) * circ;
            const dash = `${len} ${circ - len}`;
            const offset = -acc;
            acc += len;
            return (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={color}
                strokeWidth={stroke}
                strokeDasharray={dash}
                strokeDashoffset={offset}
              />
            );
          })}
      </g>
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: Math.round(size / 4.8),
          fontWeight: 700,
          fill: "var(--text)",
        }}
      >
        {rate}%
      </text>
    </svg>
  );
}

// ---------- SeverityBadge ----------

const SEVERITY_MAP: Record<string, { tone: BadgeTone; label: string }> = {
  critical: { tone: "error", label: "Critical" },
  major: { tone: "warning", label: "Major" },
  minor: { tone: "muted", label: "Minor" },
};

/** Failure severity badge (v2 FR-052): critical / major / minor. */
export function SeverityBadge({
  severity,
  testId,
}: {
  severity?: string | null;
  /** Rendered as data-testid on the wrapper <span>, which also carries data-state={severity}. */
  testId?: string;
}) {
  if (!severity) return null;
  const s = SEVERITY_MAP[severity] ?? { tone: "muted" as BadgeTone, label: severity };
  return (
    <span title={severity} data-testid={testId} data-state={severity}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

// ---------- PageHeader ----------

export function PageHeader({
  title,
  sub,
  actions,
  testId,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  /** Rendered as data-testid on the root .page-header div. */
  testId?: string;
}) {
  return (
    <div className="page-header" data-testid={testId}>
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

// ---------- Meter ----------

/** The design's labelled bar: name on the left, value on the right, bar under. */
export function Meter({
  label,
  value,
  pct,
  testId,
}: {
  label: React.ReactNode;
  value?: React.ReactNode;
  pct: number;
  /** Rendered as data-testid on the root div. */
  testId?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div data-testid={testId}>
      <div style={{ display: "flex", fontSize: 12, marginBlockEnd: 6 }}>
        <span style={{ fontWeight: 500, color: "var(--text-secondary)" }}>{label}</span>
        <span className="mono" style={{ marginInlineStart: "auto", fontSize: 11 }}>
          {value ?? `${Math.round(clamped)}%`}
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={typeof label === "string" ? label : "Coverage"}
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i
          className={clamped >= 90 ? "ok" : clamped >= 60 ? "" : "warn"}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

// ---------- Callout ----------

/** The design's tinted footer note ("Paste a fix prompt… that's the loop."). */
export function Callout({
  tone = "info",
  children,
  testId,
}: {
  tone?: "info" | "success" | "warning" | "error";
  children?: React.ReactNode;
  /** Rendered as data-testid on the root div. */
  testId?: string;
}) {
  const dot =
    tone === "success" ? "d-ok" : tone === "warning" ? "d-warn" : tone === "error" ? "d-err" : "d-blue";
  return (
    <div
      className={`callout ${tone === "info" ? "" : `callout-${tone}`}`}
      data-testid={testId}
    >
      <span className={`dot ${dot}`} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

// ---------- Toggle ----------

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  /** Accessible name — a switch with no name is an axe violation. */
  label: string;
  disabled?: boolean;
  /** Rendered as data-testid on the <button role=switch>. */
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`tog ${checked ? "tog-on" : ""}`}
      onClick={() => onChange?.(!checked)}
      data-testid={testId}
    />
  );
}

// ---------- Divider ----------

/** Hairline between rows inside a card (the design's .hr). */
export function Divider() {
  return <div className="hr" />;
}
