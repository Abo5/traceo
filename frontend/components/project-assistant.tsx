"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * The project assistant, as a panel beside the overview.
 *
 * It answers from the project's own rows and nothing else — see
 * backend/app/modules/assistant.py, which is deterministic and calls no model.
 * That property is worth surfacing rather than hiding: every reply carries the
 * ids it was built from, so a claim about a failing case can be checked against
 * the case in one click.
 *
 * It stays shut until the project has completed a run. The launcher is still
 * shown before that, disabled and saying why — a feature nobody can see is a
 * feature nobody knows to come back for.
 *
 * The width is dragged and remembered. Resizing is also on the arrow keys,
 * because a control that only exists for a mouse is a control half the people
 * using a keyboard cannot reach.
 */

type Msg = { role: "you" | "traceo"; text: string; cites?: Cite[]; engine?: string; model?: string | null };
type Cite = { kind: string; id: string; label: string };

const WIDTH_KEY = "traceo.assistant.width";
const OPEN_KEY = "traceo.assistant.open";
const MIN_W = 300;
const MAX_W = 680;

export default function ProjectAssistant({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(380);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [engine, setEngine] = useState<string>("deterministic");
  const [modelName, setModelName] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const L = {
    title: "Ask about this project",
    launcher: "Ask Traceo",
    close: "Close the assistant",
    resize: "Resize the assistant",
    placeholder: "Ask about a run, a case or a failure…",
    send: "Send",
    locked: "Available once this project has completed a run — there are no results to explain yet.",
    groundedRows: "Answers come from this project's own runs, requirements and cases. No model is called.",
    groundedModel: "Answers come from this project's own runs, requirements and cases — read by",
    groundedModelTail: "which is given those rows and nothing else.",
    byRows: "from the project's rows",
    byModel: "read by",
    empty: "Ask me what failed, why a case failed, or what this project covers.",
    thinking: "Looking…",
    failed: "Could not reach the assistant.",
  };

  useEffect(() => {
    try {
      const w = Number(localStorage.getItem(WIDTH_KEY));
      if (w >= MIN_W && w <= MAX_W) setWidth(w);
      setOpen(localStorage.getItem(OPEN_KEY) === "1");
    } catch {
      /* a browser that refuses storage still gets a working panel */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api<{ available: boolean; suggestions: string[]; engine?: string; model?: string | null }>(
      `/projects/${projectId}/assistant`)
      .then((r) => {
        if (!alive) return;
        setAvailable(!!r.available);
        setSuggestions(r.suggestions ?? []);
        setEngine(r.engine ?? "deterministic");
        setModelName(r.model ?? null);
      })
      .catch(() => alive && setAvailable(false));
    return () => {
      alive = false;
    };
  }, [projectId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  const persistWidth = useCallback((w: number) => {
    setWidth(w);
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* not worth failing a resize over */
    }
  }, []);

  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* see above */
    }
  };

  // --- resize ---------------------------------------------------------------
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX));
      persistWidth(w);
    };
    const up = () => {
      dragging.current = false;
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [persistWidth]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setDraft("");
    setMsgs((m) => [...m, { role: "you", text: q }]);
    setBusy(true);
    try {
      const r = await api<{
        answer: string; cites: Cite[]; suggestions: string[];
        engine?: string; model?: string | null;
      }>(
        `/projects/${projectId}/assistant`,
        // api() serialises the body itself — handing it a string double-encodes it.
        { method: "POST", body: { question: q } },
      );
      // Recorded per message, not per session: a dead key mid-conversation
      // silently changes which kind of thing is answering, and the reader
      // should be able to see exactly where that happened.
      setMsgs((m) => [...m, { role: "traceo", text: r.answer, cites: r.cites,
                              engine: r.engine, model: r.model }]);
      if (r.engine) setEngine(r.engine);
      if (r.suggestions?.length) setSuggestions(r.suggestions);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "traceo", text: e?.message || L.failed }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => toggle(true)}
        disabled={available === false}
        title={available === false ? L.locked : L.title}
        aria-label={L.title}
        data-testid="assistant-launcher"
        style={{
          position: "fixed",
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          zIndex: 30,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 14px",
          borderRadius: "10px 0 0 10px",
          border: "1px solid var(--border)",
          borderRight: "none",
          background: "var(--surface)",
          color: available === false ? "var(--text-muted)" : "var(--accent-text)",
          fontSize: 12.5,
          fontWeight: 600,
          cursor: available === false ? "not-allowed" : "pointer",
          boxShadow: "0 8px 26px rgba(27, 31, 43, 0.1)",
          writingMode: "vertical-rl",
        }}
      >
        {L.launcher}
      </button>
    );
  }

  return (
    <aside
      aria-label={L.title}
      data-testid="assistant-panel"
      style={{
        position: "fixed",
        // Below the shell's topbar, which is sticky at z-index 40 and owns the
        // top of the viewport. Starting at 0 put this panel's close button
        // underneath the sign-out control, where it could not be clicked.
        top: "var(--top-h, 56px)",
        right: 0,
        bottom: 0,
        width,
        zIndex: 30,
        display: "flex",
        background: "var(--surface)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "-18px 0 40px rgba(27, 31, 43, 0.08)",
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={L.resize}
        // A focusable separator is a window splitter, and a splitter has to
        // report where it is — without these a screen reader announces a
        // control with no value and no range.
        aria-valuenow={width}
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        tabIndex={0}
        data-testid="assistant-resize-handle"
        onPointerDown={(e) => {
          dragging.current = true;
          document.body.style.userSelect = "none";
          e.preventDefault();
        }}
        onKeyDown={(e) => {
          // Arrow keys move it too. A drag handle is unreachable without a
          // pointer otherwise, and the panel would be stuck at whatever width
          // it happened to be.
          if (e.key === "ArrowLeft") persistWidth(Math.min(MAX_W, width + 24));
          if (e.key === "ArrowRight") persistWidth(Math.max(MIN_W, width - 24));
        }}
        style={{ width: 6, cursor: "col-resize", background: "transparent", flex: "0 0 auto" }}
      />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 14px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <strong style={{ fontSize: 13.5, flex: 1 }}>{L.title}</strong>
          <button
            type="button"
            onClick={() => toggle(false)}
            aria-label={L.close}
            data-testid="assistant-close"
            style={{
              border: "none", background: "none", cursor: "pointer",
              color: "var(--text-secondary)", fontSize: 15, lineHeight: 1, padding: 4,
            }}
          >
            ✕
          </button>
        </header>

        <p
          style={{
            margin: 0, padding: "10px 14px", fontSize: 11.5, lineHeight: 1.5,
            color: "var(--text-muted)", borderBottom: "1px solid var(--border)",
          }}
        >
          {engine === "model" && modelName
            ? `${L.groundedModel} ${modelName} — ${L.groundedModelTail}`
            : L.groundedRows}
        </p>

        <div
          ref={listRef}
          aria-live="polite"
          // The transcript scrolls, so it has to be reachable without a mouse.
          // A scrollable region nobody can focus is content a keyboard user
          // cannot read past the first screenful.
          tabIndex={0}
          role="log"
          aria-label="Assistant transcript"
          data-testid="assistant-messages"
          style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}
        >
          {msgs.length === 0 && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>{L.empty}</p>
          )}
          {msgs.map((m, i) => (
            <div key={i} data-testid={`assistant-msg-${m.role}`}>
              <div
                style={{
                  fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
                  color: "var(--text-muted)", marginBottom: 4,
                }}
              >
                {m.role}
                {m.role === "traceo" && m.engine && (
                  <span
                    data-testid="assistant-engine"
                    // No opacity: --text-muted is already the lightest text
                    // that clears AA, and fading it took it under.
                    style={{ marginLeft: 8, color: "var(--text-secondary)" }}
                  >
                    · {m.engine === "model" ? `${L.byModel} ${m.model ?? "a model"}` : L.byRows}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap",
                  color: "var(--text)", background: m.role === "you" ? "var(--surface-2)" : "transparent",
                  padding: m.role === "you" ? "8px 10px" : 0,
                  borderRadius: 8,
                }}
              >
                {m.text}
              </div>
              {!!m.cites?.length && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {m.cites.slice(0, 8).map((c, j) => (
                    <span
                      key={j}
                      title={c.label}
                      data-testid="assistant-cite"
                      style={{
                        fontFamily: "var(--font-mono, monospace)", fontSize: 10,
                        padding: "3px 7px", borderRadius: 5,
                        border: "1px solid var(--border)", color: "var(--accent-text)",
                      }}
                    >
                      {c.kind}:{c.id.slice(0, 8)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }}>{L.thinking}</p>
          )}
        </div>

        {suggestions.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 14px 10px" }}>
            {suggestions.slice(0, 4).map((sug) => (
              <button
                key={sug}
                type="button"
                onClick={() => send(sug)}
                disabled={busy}
                data-testid="assistant-suggestion"
                style={{
                  fontSize: 11.5, padding: "6px 10px", borderRadius: 999,
                  border: "1px solid var(--border)", background: "var(--surface-2)",
                  color: "var(--text-secondary)", cursor: "pointer",
                }}
              >
                {sug}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
          style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border)" }}
        >
          <label htmlFor="assistant-input" className="sr-only" style={{ position: "absolute", left: -9999 }}>
            {L.placeholder}
          </label>
          <input
            id="assistant-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={L.placeholder}
            disabled={busy}
            data-testid="assistant-input"
            style={{
              flex: 1, minWidth: 0, fontSize: 13, padding: "9px 11px",
              borderRadius: 9, border: "1px solid var(--border)",
              background: "var(--surface)", color: "var(--text)",
            }}
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            data-testid="assistant-send"
            style={{
              fontSize: 12.5, fontWeight: 600, padding: "9px 14px", borderRadius: 9,
              border: "none", background: "var(--accent-fill)", color: "var(--accent-fg)",
              cursor: busy || !draft.trim() ? "default" : "pointer",
              opacity: busy || !draft.trim() ? 0.55 : 1,
            }}
          >
            {L.send}
          </button>
        </form>
      </div>
    </aside>
  );
}
