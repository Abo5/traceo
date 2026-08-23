"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import StageCanvas, { type CanvasHandle } from "@/components/landing/stage-canvas";
import type { BugInfo, Stage } from "@/components/landing/scene";
import s from "./landing.module.css";

/**
 * The landing page.
 *
 * One WebGL scene sits fixed behind the whole scroll, and the copy scrolls over
 * it in four acts — look, generate, run, fix — which are the four things the
 * product actually does, in the order it does them. The canvas is told which act
 * it is in and rearranges itself; the visitor can grab it at any point and spin
 * it, sweep the scanner across the page, or click a defect to repair it.
 *
 * The interaction is not decoration. Clicking a red marker produces the same
 * artefact the product produces — a fix prompt with the case, the requirement it
 * traces to, and the actions to take — so the fun bit and the pitch are the
 * same gesture. The prompts below are real output shapes from
 * backend/app/modules/fixprompt.py, not invented marketing copy.
 */

const ACTS: {
  id: Stage;
  num: string;
  kicker: string;
  title: string;
  body: string;
  note?: string;
}[] = [
  {
    id: 1,
    num: "01",
    kicker: "Discovery",
    title: "What the application declares about itself",
    body:
      "No sitemap to author, no configuration to maintain. Traceo renders the page as a browser does and records what is present: every field and its type, whether it is required, the length it permits, the pattern it must match, and the destination of every link.",
    note: "Move the cursor across the interface — this is what discovery reads.",
  },
  {
    id: 2,
    num: "02",
    kicker: "Derivation",
    title: "Cases bound to observed evidence",
    body:
      "A candidate case must cite something discovery observed, or it is discarded — and counted, so the number is on the record. The three falling out here cite rules this form never declared: a password-strength policy, a two-factor timeout. A suite that asserts behaviour the application never claimed is worse than no suite at all.",
    note: "Seven retained. Three discarded, and reported as discarded.",
  },
  {
    id: 3,
    num: "03",
    kicker: "Execution",
    title: "Performed, not predicted",
    body:
      "Each case is executed in a browser against the running page: fields are filled, forms are submitted, responses are awaited. Every result recorded here was observed happening — none of it is an estimate of how the application would probably behave.",
    note: "Submissions are dry-run by default; writing to your data requires explicit consent.",
  },
  {
    id: 4,
    num: "04",
    kicker: "Remediation",
    title: "Every failure, with instructions attached",
    body:
      "Each failure carries a remediation brief assembled from the case, the requirement it violates, and the evidence recorded at the moment it broke. It is deterministic and produced offline, so the same failure yields the same brief on every machine — and the case that produced it is the case that closes it.",
    note: "Select a marked defect to review its brief, or resolve all three at once.",
  },
];

const FEATURES = [
  {
    k: "Grounded",
    t: "Every case cites its source",
    d: "Each generated case names the element, endpoint or requirement it was derived from. A case that cannot cite one does not reach your suite.",
  },
  {
    k: "Deterministic",
    t: "Remediation briefs call no model",
    d: "They are assembled from records you already hold, so the same failure produces an identical brief on every machine — and a brief can be quoted in a defect report.",
  },
  {
    k: "Traceable",
    t: "Requirement to result, in both directions",
    d: "Open a requirement to see which cases cover it and how they last executed. Open a failure to see which requirement it breaches.",
  },
  {
    k: "Scoped",
    t: "Functionality, interface, API, performance, security",
    d: "Declare what a project is for and Traceo offers only those disciplines. Scope it once; nothing outside that scope is proposed again.",
  },
];

export default function LandingPage() {
  const [stage, setStage] = useState<Stage>(0);
  const [bugs, setBugs] = useState<{ remaining: number; total: number }>({ remaining: 3, total: 3 });
  const [prompt, setPrompt] = useState<BugInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const canvas = useRef<CanvasHandle | null>(null);
  const actRefs = useRef<(HTMLElement | null)[]>([]);

  // Which act is on screen drives the scene. IntersectionObserver rather than a
  // scroll handler: no work happens between the boundaries that matter.
  useEffect(() => {
    const nodes = actRefs.current.filter(Boolean) as HTMLElement[];
    if (!nodes.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const next = Number((visible.target as HTMLElement).dataset.stage) as Stage;
        setStage(next);
      },
      { threshold: [0.45], rootMargin: "-10% 0px -10% 0px" }
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);

  const onFixed = useCallback((b: BugInfo) => {
    setPrompt(b);
    setCopied(false);
  }, []);

  const onCount = useCallback((remaining: number, total: number) => {
    setBugs({ remaining, total });
  }, []);

  const promptText = useMemo(() => (prompt ? renderPrompt(prompt) : ""), [prompt]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className={s.page} data-testid="landing-root">
      {/* --- the scene, fixed behind everything above the fold --------------- */}
      <div className={s.sceneWrap} aria-hidden="true">
        <div className={s.sceneSticky}>
          <StageCanvas
            ref={canvas}
            stage={stage}
            onBugFixed={onFixed}
            onBugCount={onCount}
            className={s.canvas}
          />
        </div>
      </div>

      <div className={s.scroller}>
        {/* --- hero --------------------------------------------------------- */}
        <section
          className={s.hero}
          ref={(el) => { actRefs.current[0] = el; }}
          data-stage="0"
          data-testid="landing-hero"
        >
          <div className={s.heroInner}>
            <span className={s.eyebrow}>Traceo · TADQEEQ</span>
            <h1 className={s.h1}>
              From requirement
              <br />
              to <em>executed test.</em>
            </h1>
            <p className={s.lede}>
              Traceo renders your application in a real browser, derives test cases from what it
              observes, executes them against the running page, and returns a remediation brief for
              every failure.
            </p>
            <div className={s.ctaRow}>
              <Link href="/projects" className={s.ctaPrimary} data-testid="landing-cta-app">
                Open the application
              </Link>
              <a href="#act-1" className={s.ctaGhost} data-testid="landing-cta-scroll">
                View the method
                <span aria-hidden="true"> ↓</span>
              </a>
            </div>
            <p className={s.hint} data-testid="landing-hint">
              <span className={s.kbd}>Drag</span> to rotate ·{" "}
              <span className={s.kbd}>move</span> the cursor to inspect
            </p>
          </div>
          <span className={s.scrollCue} aria-hidden="true" />
        </section>

        {/* --- the four acts ------------------------------------------------ */}
        {ACTS.map((act, i) => (
          <section
            key={act.id}
            id={`act-${act.id}`}
            className={s.act}
            ref={(el) => { actRefs.current[i + 1] = el; }}
            data-stage={act.id}
            data-testid={`landing-act-${act.id}`}
          >
            <div className={`${s.actCard} ${act.id % 2 === 0 ? s.actRight : ""}`}>
              <span className={s.kicker}>
                <span className={s.kickerNum}>{act.num}</span>
                {act.kicker}
              </span>
              <h2 className={s.h2}>{act.title}</h2>
              <p className={s.body}>{act.body}</p>
              {act.note && <p className={s.note}>{act.note}</p>}

              {act.id === 4 && (
                <div className={s.bugBar} data-testid="landing-bug-bar">
                  <span className={s.bugCount} data-clear={bugs.remaining === 0 ? "1" : "0"}>
                    {bugs.remaining === 0 ? (
                      <>
                        <b>{bugs.total} of {bugs.total}</b> resolved
                      </>
                    ) : (
                      <>
                        <b>{bugs.remaining}</b> defect{bugs.remaining === 1 ? "" : "s"} outstanding
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    className={s.smallBtn}
                    onClick={() => canvas.current?.fixAll()}
                    disabled={bugs.remaining === 0}
                    data-testid="landing-fix-all"
                  >
                    Resolve all
                  </button>
                </div>
              )}

              {act.id === 4 && prompt && (
                <div className={s.prompt} data-testid="landing-fix-prompt">
                  <header className={s.promptHead}>
                    <span className={s.promptTag}>remediation brief</span>
                    <span className={s.promptHint}>
                      {prompt.remaining === 0 ? "final defect" : `${prompt.remaining} remaining`}
                    </span>
                    <button
                      type="button"
                      className={s.promptClose}
                      onClick={() => setPrompt(null)}
                      aria-label="Dismiss fix prompt"
                    >
                      ✕
                    </button>
                  </header>
                  <pre className={s.promptBody}>{promptText}</pre>
                  <button type="button" className={s.smallBtn} onClick={copy} data-testid="landing-copy-prompt">
                    {copied ? "Copied" : "Copy brief"}
                  </button>
                </div>
              )}
            </div>
          </section>
        ))}
      </div>

      {/* --- the light half ------------------------------------------------- */}
      <section className={s.features} data-testid="landing-features">
        <div className={s.featuresInner}>
          <h2 className={s.h2Light}>What a passing result is permitted to mean</h2>
          <p className={s.subLight}>
            A testing tool is worth exactly what its passing results are worth. These are the four
            properties Traceo holds to so that a pass carries evidence behind it.
          </p>
          <div className={s.grid}>
            {FEATURES.map((f) => (
              <article key={f.k} className={s.feature}>
                <span className={s.featureKicker}>{f.k}</span>
                <h3 className={s.featureTitle}>{f.t}</h3>
                <p className={s.featureBody}>{f.d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className={s.closer} data-testid="landing-closer">
        <div className={s.closerInner}>
          <h2 className={s.h2Light}>Point Traceo at an environment.</h2>
          <p className={s.subLight}>
            Discovery of a form-heavy page completes in a few minutes and returns executed cases you
            did not author, against an interface you did not have to describe.
          </p>
          <Link href="/projects" className={s.ctaPrimary} data-testid="landing-cta-final">
            Begin a run
          </Link>
        </div>
      </section>
    </main>
  );
}

/** The on-screen prompt, in the shape `fixprompt.build_fix_prompt` emits. */
function renderPrompt(b: BugInfo): string {
  const pad = (label: string) => label.padEnd(16, " ");
  const lines = [
    "# Fix request — generated by Traceo",
    "",
    pad("What is broken") + b.title,
    pad("Where") + b.where,
    pad("Requirement") + b.requirement,
    pad("Severity") + "high",
  ];
  b.actions.forEach((a, i) => lines.push(pad(i === 0 ? "Do" : "") + `${i + 1}) ${a}`));
  lines.push(pad("Verify") + "re-run this case — when it passes, this closes");
  lines.push("");
  lines.push(
    "Change the application, not the test: this case states a rule the product agreed to, so a passing test must mean the rule now holds."
  );
  return lines.join("\n");
}
