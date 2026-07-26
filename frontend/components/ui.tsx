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
