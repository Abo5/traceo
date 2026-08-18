"use client";

import React, { useEffect } from "react";
import { ensureSession } from "@/lib/api";
import AppShell from "@/components/shell";

/**
 * The application shell.
 *
 * Signing in is not part of this build. There is no login route, no
 * registration route and no sign-out control: `ensureSession` obtains a session
 * from the backend's dev-session endpoint before the first request goes out,
 * and every screen simply assumes it. Nothing here can strand the user at a
 * form, because no form exists to strand them at.
 *
 * The backend refuses to boot in production with that endpoint enabled
 * (`assert_production_safe`), so this trade is loud rather than silent.
 *
 * The chrome itself — icon rail, project sidebar, topbar — lives in
 * components/shell.tsx, ported from the v3 design.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void ensureSession();
  }, []);

  return <AppShell>{children}</AppShell>;
}
