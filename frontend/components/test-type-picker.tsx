"use client";

import React from "react";
import { TEST_TYPES, TEST_TYPE_META, type TestType } from "@/lib/test-types";

/**
 * The five test types as toggle buttons.
 *
 * Used when a project is created, when its scope is changed, and when a URL is
 * pointed at — the same control in every place the choice is made, so the five
 * types cannot drift apart across screens.
 *
 * `testIdPrefix` keeps each usage separately addressable (`project-type-api`,
 * `target-type-api`) while the markup stays one implementation. The rendered
 * control is a real checkbox: it is what a keyboard and a screen reader expect,
 * and its checked state is readable without interpreting colour.
 */
export function TestTypePicker({
  selected,
  onToggle,
  disabled = false,
  testIdPrefix,
  description = "scope",
  limitTo,
}: {
  selected: readonly TestType[];
  onToggle: (type: TestType) => void;
  disabled?: boolean;
  testIdPrefix: string;
  /** Which of the two descriptions to show — see lib/test-types.ts. */
  description?: "scope" | "hint";
  /**
   * When present, the types this project is set up for. Anything outside it is
   * shown but not selectable, because the backend would refuse it: offering a
   * control that always fails is worse than showing why it is unavailable.
   */
  limitTo?: readonly TestType[] | null;
}) {
  const chosen = new Set(selected);
  const allowed = limitTo ? new Set(limitTo) : null;

  return (
    <div
      data-testid={`${testIdPrefix}-picker`}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 8,
      }}
    >
      {TEST_TYPES.map((type) => {
        const meta = TEST_TYPE_META[type];
        const outOfScope = allowed !== null && !allowed.has(type);
        const on = chosen.has(type);
        const locked = disabled || outOfScope;
        return (
          <label
            key={type}
            data-testid={`${testIdPrefix}-row`}
            data-state={type}
            title={outOfScope ? "This project is not set up for this type." : undefined}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: "12px 14px",
              borderRadius: 12,
              cursor: locked ? "not-allowed" : "pointer",
              opacity: outOfScope ? 0.45 : 1,
              border: on ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: on ? "var(--accent-subtle)" : "var(--surface-2)",
              transition: "border-color 120ms, background 120ms",
            }}
          >
            <input
              type="checkbox"
              data-testid={`${testIdPrefix}-${type}`}
              checked={on}
              disabled={locked}
              onChange={() => onToggle(type)}
              style={{ marginTop: 3, accentColor: "var(--accent)" }}
            />
            <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                {meta.label}{" "}
                <span
                  className="mono"
                  style={{ color: "var(--text-secondary)", fontSize: 11 }}
                >
                  {type}
                </span>
              </span>
              <span
                data-testid={`${testIdPrefix}-${type}-hint`}
                style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}
              >
                {description === "hint" ? meta.hint : meta.scope}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
