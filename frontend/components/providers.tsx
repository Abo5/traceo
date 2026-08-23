"use client";

import React, { useCallback, useEffect, useState } from "react";
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
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "out" | "in">("checking");

  const settle = useCallback(() => {
    setState(getToken() ? "in" : "out");
  }, []);

  useEffect(() => {
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
  }, [settle]);

  if (state === "checking") return <div className="auth-wrap" aria-busy="true" />;
  if (state === "out") return <AuthScreen onDone={settle} />;
  return <AppShell>{children}</AppShell>;
}
