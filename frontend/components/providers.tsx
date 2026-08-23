"use client";

import React, { useEffect } from "react";
import { usePathname } from "next/navigation";
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
 *
 * The landing page is the one route that opts out of both halves. It is the
 * public face of the product rather than a screen inside it, so it renders
 * full-bleed with no rail or sidebar, and it does not reach for a session:
 * a marketing page that cannot be read until a backend answers is a marketing
 * page that is down whenever the backend is.
 */

/** Routes that render bare — no chrome, no session. */
const PUBLIC_ROUTES = ["/landing"];
export default function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));

  useEffect(() => {
    if (isPublic) return;
    void ensureSession();
  }, [isPublic]);

  if (isPublic) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}
