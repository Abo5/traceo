"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";
import type { BugInfo, Stage, TraceoScene } from "./scene";

/**
 * The React side of the hero: lifecycle, scroll→stage wiring, and the fix-prompt
 * card that a fixed bug leaves behind.
 *
 * three is loaded with a dynamic import so the 600 KB it costs stays out of the
 * route's first payload — the headline paints immediately and the canvas fades
 * in behind it a moment later. A visitor on a machine without WebGL, or one who
 * has asked for reduced motion, still gets a finished page: the fallback is a
 * styled gradient, and every word of the explanation lives in HTML either way.
 */

type Props = {
  stage: Stage;
  onBugFixed?: (bug: BugInfo) => void;
  onBugCount?: (remaining: number, total: number) => void;
  className?: string;
  /** React 19 passes ref as an ordinary prop — no forwardRef wrapper needed. */
  ref?: Ref<CanvasHandle>;
};

export type CanvasHandle = { fixAll: () => void };

export default function StageCanvas({ stage, onBugFixed, onBugCount, className, ref }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<TraceoScene | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Callbacks land in refs so a re-render never tears down the scene.
  const fixedCb = useRef(onBugFixed);
  const countCb = useRef(onBugCount);
  fixedCb.current = onBugFixed;
  countCb.current = onBugCount;

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const supported = (() => {
      try {
        const c = document.createElement("canvas");
        return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
      } catch {
        return false;
      }
    })();
    if (!supported) {
      setFailed(true);
      return;
    }

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    import("./scene")
      .then(({ TraceoScene: Scene }) => {
        if (cancelled || !hostRef.current) return;
        sceneRef.current = new Scene(hostRef.current, {
          reducedMotion: reduced,
          onBugFixed: (b) => fixedCb.current?.(b),
          onBugCount: (r, t) => countCb.current?.(r, t),
        });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setStage(stage);
  }, [stage]);

  // Nothing off-screen should be burning a GPU frame.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) sceneRef.current?.start();
        else sceneRef.current?.stop();
      },
      { threshold: 0.01 }
    );
    io.observe(host);
    return () => io.disconnect();
  }, [ready]);

  const fixAll = useCallback(() => sceneRef.current?.fixAll(), []);
  useImperativeHandle(ref, () => ({ fixAll }), [fixAll]);

  return (
    <div className={className} ref={hostRef} data-ready={ready ? "1" : "0"} data-testid="landing-canvas">
      {failed && (
        <div className="landing-canvas-fallback" aria-hidden="true">
          <span />
        </div>
      )}
    </div>
  );
}
