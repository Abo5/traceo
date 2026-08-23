"use client";

import React, { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ensureSession, getToken } from "@/lib/api";
import AppShell from "@/components/shell";
import AuthScreen from "@/components/auth-screen";

/**
 * The application shell, and the gate in front of it.
 *
 * Three states, and the middle one is the reason this is not a one-liner:
 *
 *   checking — nothing is rendered. A flash of the sign-in form in front of a
 *              user who is already signed in is worse than a blank moment, and
 *              rendering the shell first would fire every screen's initial fetch
 *              without a token and paint a wall of 401s.
 *   signed out — AuthScreen, in place of the shell. There is no route to the app
 *              around it because the app is not mounted at all.
 *   signed in  — the shell, exactly as before.
 *
 * A backend running with TRACEO_DEV_AUTOLOGIN=1 still short-circuits the gate:
 * ensureSession asks for a credential-free session first, and only when that is
 * refused (404 on any normal backend) does the sign-in screen appear. So the
 * development convenience survives without the production build depending on it.
 *
 * The chrome itself — icon rail, project sidebar, topbar — lives in
 * components/shell.tsx, ported from the v3 design.
 *
 * PUBLIC ROUTES SIT IN FRONT OF ALL THREE STATES. The landing page is the
 * product's public face rather than a screen inside it: it must render for
 * someone who has never signed in, which is precisely the person the gate above
 * is built to stop. Sending that visitor to a sign-in form is not a degraded
 * landing page, it is no landing page. So a public route renders bare — no
 * gate, no chrome — and never reaches for a session, because a marketing page
 * that cannot be read until a backend answers is a marketing page that is down
 * whenever the backend is.
 */

/** Rendered bare: no gate, no chrome, no session. */
const PUBLIC_ROUTES = ["/landing"];

export default function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname?.startsWith(route + "/"),
  );

  const [state, setState] = useState<"checking" | "out" | "in">("checking");

  const settle = useCallback(() => {
    setState(getToken() ? "in" : "out");
  }, []);

  useEffect(() => {
    // The hook still runs — hooks must — but a public route asks the backend
    // for nothing at all.
    if (isPublic) return;

    let alive = true;
    (async () => {
      if (getToken()) {
        if (alive) setState("in");
        return;
      }
      // No stored token: give the dev-session endpoint its one chance before
      // deciding this user has to sign in.
      await ensureSession().catch(() => false);
      if (alive) settle();
    })();

    // A sign-out (or a session cleared in another tab) has to move the gate, not
    // just the chrome — otherwise the shell stays mounted with no token and every
    // fetch behind it fails.
    const onAuth = () => alive && settle();
    window.addEventListener("traceo-auth", onAuth);
    window.addEventListener("storage", onAuth);
    return () => {
      alive = false;
      window.removeEventListener("traceo-auth", onAuth);
      window.removeEventListener("storage", onAuth);
    };
  }, [settle, isPublic]);

  if (isPublic) return <>{children}</>;
  if (state === "checking") return <div className="auth-wrap" aria-busy="true" />;
  if (state === "out") return <AuthScreen onDone={settle} />;
  return <AppShell>{children}</AppShell>;
}
