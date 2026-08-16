"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The root sends every visitor straight into the app.
 *
 * There is no sign-in screen to send anyone to: the login and registration
 * routes were removed from this build, and the session comes from the backend's
 * dev-session endpoint (see `ensureSession` in lib/api). A production backend
 * refuses to start with that flag set, so this build is not deployable as-is —
 * which is the intended trade: no login means no login, not a hidden one.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/projects");
  }, [router]);
  return null;
}
