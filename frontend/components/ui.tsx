"use client";

import React, { useEffect } from "react";

// ---------- Button ----------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className ?? ""}`}
      type={props.type ?? "button"}
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
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  pad?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`card ${className ?? ""}`} style={style}>
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
}: {
  tone?: BadgeTone;
  children?: React.ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

// ---------- Pill ----------

export function Pill({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button type="button" className={`pill ${active ? "pill-active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

// ---------- StatCard ----------

export function StatCard({
  value,
  label,
  color,
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-value mono" dir="ltr" style={color ? { color } : undefined}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// ---------- Table ----------

export function Table({
  head,
  children,
}: {
  head: React.ReactNode[];
  children?: React.ReactNode;
}) {
  return (
    <div className="table-wrap">
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

export function Progress({ pct, tone }: { pct: number; tone?: string }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const bg = tone
    ? PROGRESS_TONES[tone] ?? tone
    : "linear-gradient(90deg, var(--c-amber), var(--c-pink))";
  return (
    <div className="progress" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${clamped}%`, background: bg }} />
    </div>
  );
}

// ---------- Empty ----------

export function Empty({
  icon,
  title,
  hint,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>
        {icon ?? "◌"}
      </div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
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
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="close">
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
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input className={`input ${className ?? ""}`} {...rest} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return <select className={`input select ${className ?? ""}`} {...rest} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props;
  return <textarea className={`input textarea ${className ?? ""}`} {...rest} />;
}

// ---------- Mono ----------

export function Mono({
  children,
  className,
  style,
}: {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span className={`mono ${className ?? ""}`} dir="ltr" style={style}>
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

export function StatusDot({ state }: { state: string }) {
  const tone = stateTone(state);
  return <span className="status-dot" style={{ background: TONE_COLORS[tone] }} title={state} />;
}

// ---------- DateTimeText ----------

/** Formats an ISO datetime as YYYY-MM-DD HH:mm (stable, bidi-safe). */
export function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** LTR mono datetime — immune to RTL bidi scrambling. */
export function DateTimeText({
  value,
  style,
}: {
  value?: string | null;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="mono"
      dir="ltr"
      style={{ fontSize: 11, whiteSpace: "nowrap", unicodeBidi: "isolate", ...style }}
    >
      {fmtDateTime(value)}
    </span>
  );
}

// ---------- RefChip ----------

/** v2 FR-reference chip: mono amber id like "FR-054". */
export function RefChip({ id }: { id: string }) {
  return (
    <span
      className="mono"
      dir="ltr"
      style={{
        display: "inline-block",
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: "0.03em",
        color: "var(--accent)",
        background: "var(--accent-subtle)",
        border: "1px solid transparent",
        borderRadius: 6,
        padding: "1px 6px",
        whiteSpace: "nowrap",
        lineHeight: 1.7,
        verticalAlign: "middle",
      }}
    >
      {id}
    </span>
  );
}

// ---------- TrendBars ----------

/** Inline gradient bar chart of coverage per run (v2 FR-054). */
export function TrendBars({
  data,
  height = 120,
}: {
  data: { display_id?: number | string; coverage_pct?: number }[];
  height?: number;
}) {
  return (
    <div
      dir="ltr"
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 6,
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
              width: 10,
              height: `${Math.max(pct, 3)}%`,
              borderRadius: "3px 3px 0 0",
              background: "linear-gradient(135deg,#FF8A22,#FF5C72)",
              flexShrink: 0,
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
}: {
  passed: number;
  failed: number;
  errored: number;
  size?: number;
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
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${rate}%`}>
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
          direction: "ltr",
        }}
      >
        {rate}%
      </text>
    </svg>
  );
}

// ---------- SeverityBadge ----------

const SEVERITY_MAP: Record<string, { tone: BadgeTone; ar: string }> = {
  critical: { tone: "error", ar: "حرج" },
  major: { tone: "warning", ar: "كبير" },
  minor: { tone: "muted", ar: "طفيف" },
};

/** Failure severity badge (v2 FR-052): critical/major/minor with Arabic labels. */
export function SeverityBadge({ severity }: { severity?: string | null }) {
  if (!severity) return null;
  const s = SEVERITY_MAP[severity] ?? { tone: "muted" as BadgeTone, ar: severity };
  return (
    <span title={severity}>
      <Badge tone={s.tone}>{s.ar}</Badge>
    </span>
  );
}

// ---------- PageHeader ----------

export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
