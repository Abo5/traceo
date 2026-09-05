"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, login } from "@/lib/api";
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

const ACTS: { id: Stage; kicker: string; title: string; body: string; note?: string }[] = [
  {
    id: 1,
    kicker: "01 — Look",
    title: "It reads your page like a tester who actually clicks things",
    body:
      "No sitemap to write, no config to fill in. Traceo opens your URL in a real browser and reads what is there: every input and its type, whether it is required, how long it may be, the pattern it must match, where each link goes.",
    note: "Move your cursor across the app — that is roughly what it sees.",
  },
  {
    id: 2,
    kicker: "02 — Generate",
    title: "It refuses to test things you never claimed",
    body:
      "Here is the unglamorous part that matters most. A case has to cite something discovery actually found, or it is thrown away — and counted, so you can see how many. Watch the red ones fall out: a password-strength rule your form never declared, a 2FA timeout that does not exist.",
    note: "A suite that tests imaginary behaviour is worse than no suite at all.",
  },
  {
    id: 3,
    kicker: "03 — Run",
    title: "Then it actually runs them",
    body:
      "In a browser, against your real page. It types, it tabs, it submits, it waits for what comes back. Nothing here is a prediction of what your app would probably do — every green is something that was observed happening.",
    note: "Submissions are dry-run by default. Traceo asks before it writes to your database.",
  },
  {
    id: 4,
    kicker: "04 — Fix",
    title: "And every red comes with instructions",
    body:
      "Each failure carries a paste-ready fix prompt built from the case, the requirement it violated, and the evidence recorded the moment it broke. Paste it into Claude or Cursor, apply it, re-run — the case that produced the prompt is the case that closes it.",
    note: "Click a red marker on the app to try it — or fix them all at once.",
  },
];

const SIGN_IN = {
  kicker: "Sign in",
  title: "Your app is already in there. Come and get it.",
  body:
    "The window beside you is the shape of the thing Traceo works on. Sign in and it stops being a demonstration.",
  email: "Email",
  password: "Password",
  submit: "Sign in",
  working: "Signing in…",
  hint: "No account? The sign-up form lives inside the app.",
};

const FEATURES = [
  {
    k: "Grounded",
    t: "It cites its sources",
    d: "Every generated case points at the element, endpoint or requirement it came from. Anything that cannot is discarded before it reaches your suite.",
  },
  {
    k: "Offline",
    t: "Fix prompts call no model",
    d: "They are assembled from rows you already have, so the same failure produces the same prompt on every machine — and you can paste one into a bug report.",
  },
  {
    k: "Traceable",
    t: "Requirement to result, both ways",
    d: "Open a requirement and see which cases cover it and how they last ran. Open a failure and see which requirement it breaks.",
  },
  {
    k: "Five kinds",
    t: "Functionality, UI, API, performance, security",
    d: "Pick what a project is for and Traceo only offers those. Scope it once; nothing irrelevant shows up again.",
  },
];

export default function LandingPage() {
  const [stage, setStage] = useState<Stage>(0);
  const [bugs, setBugs] = useState<{ remaining: number; total: number }>({ remaining: 3, total: 3 });
  const [prompt, setPrompt] = useState<BugInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const canvas = useRef<CanvasHandle | null>(null);
  const actRefs = useRef<(HTMLElement | null)[]>([]);
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  /** True while the light half covers the canvas — see StageCanvas.paused. */
  const [covered, setCovered] = useState(false);

  async function submitSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (signingIn) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      await login(email.trim(), password);
      router.push("/projects");
    } catch (err) {
      // The message the server sent, when it sent one. "Something went wrong"
      // in front of a password field is the least useful sentence in software.
      setSignInError(
        err instanceof ApiError
          ? err.message
          : "Could not reach the server. Check that the backend is running.",
      );
      setSigningIn(false);
    }
  }

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

  // The canvas is fixed behind the page, so it cannot tell for itself when the
  // opaque light half has covered it. This watches the two regions that are
  // meant to show it and stops the loop when neither does.
  useEffect(() => {
    const dark = [
      document.querySelector("[data-testid=landing-hero]"),
      document.querySelector("[data-testid=landing-signin]"),
      ...Array.from(document.querySelectorAll("[data-testid^=landing-act-]")),
    ].filter(Boolean) as Element[];
    if (!dark.length) return;
    const visible = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target);
          else visible.delete(e.target);
        }
        setCovered(visible.size === 0);
      },
      { threshold: 0 },
    );
    dark.forEach((n) => io.observe(n));
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
            paused={covered}
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
              Point it at your app.
              <br />
              <em>It clicks everything.</em>
            </h1>
            <p className={s.lede}>
              Traceo opens your site in a real browser, finds every field, rule and link, writes
              tests grounded in what it actually found, runs them, and hands you a fix prompt for
              each failure.
            </p>
            <div className={s.ctaRow}>
              <Link href="/projects" className={s.ctaPrimary} data-testid="landing-cta-app">
                Open the app
              </Link>
              <a href="#act-1" className={s.ctaGhost} data-testid="landing-cta-scroll">
                See how it works
                <span aria-hidden="true"> ↓</span>
              </a>
            </div>
            <p className={s.hint} data-testid="landing-hint">
              <span className={s.kbd}>drag</span> to spin it ·{" "}
              <span className={s.kbd}>move</span> your cursor to scan
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
              <span className={s.kicker}>{act.kicker}</span>
              <h2 className={s.h2}>{act.title}</h2>
              <p className={s.body}>{act.body}</p>
              {act.note && <p className={s.note}>{act.note}</p>}

              {act.id === 4 && (
                <div className={s.bugBar} data-testid="landing-bug-bar">
                  <span className={s.bugCount}>
                    {bugs.remaining === 0 ? (
                      <>All clear — {bugs.total} fixed</>
                    ) : (
                      <>
                        <b>{bugs.remaining}</b> defect{bugs.remaining === 1 ? "" : "s"} left on the app
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
                    Fix them all
                  </button>
                </div>
              )}

              {act.id === 4 && prompt && (
                <div className={s.prompt} data-testid="landing-fix-prompt">
                  <header className={s.promptHead}>
                    <span className={s.promptTag}>fix prompt</span>
                    <span className={s.promptHint}>
                      {prompt.remaining === 0 ? "that was the last one" : `${prompt.remaining} to go`}
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
                    {copied ? "Copied" : "Copy prompt"}
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
          <h2 className={s.h2Light}>What you get, and what you can trust</h2>
          <p className={s.subLight}>
            A testing tool is only worth as much as its greens are. These are the four things Traceo
            does to make sure a green means something.
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

      {/* The model is the frame; the credentials are HTML */}
      <section
        className={s.signin}
        data-testid="landing-signin"
        ref={(el) => { actRefs.current[5] = el; }}
        data-stage="5"
      >
        <div className={s.signinInner}>
          <span className={s.kicker}>{SIGN_IN.kicker}</span>
          <h2 className={s.h2}>{SIGN_IN.title}</h2>
          <p className={s.body}>{SIGN_IN.body}</p>

          <form className={s.signinForm} onSubmit={submitSignIn} data-testid="landing-signin-form">
            <label className={s.field}>
              <span className={s.fieldLabel}>{SIGN_IN.email}</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={s.input}
                data-testid="landing-signin-email"
              />
            </label>
            <label className={s.field}>
              <span className={s.fieldLabel}>{SIGN_IN.password}</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={s.input}
                data-testid="landing-signin-password"
              />
            </label>

            {signInError && (
              <p className={s.signinError} role="alert" data-testid="landing-signin-error">
                {signInError}
              </p>
            )}

            <button
              type="submit"
              className={s.ctaPrimary}
              disabled={signingIn}
              data-testid="landing-signin-submit"
            >
              {signingIn ? SIGN_IN.working : SIGN_IN.submit}
            </button>
          </form>

          <p className={s.hint}>{SIGN_IN.hint}</p>
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
