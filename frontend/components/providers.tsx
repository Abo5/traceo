"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ensureSession, getToken, getUser } from "@/lib/api";

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
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<{ token: string | null; user: any | null }>({
    token: null,
    user: null,
  });

  // auth state (token + cached user from localStorage 'traceo_user')
  useEffect(() => {
    const read = () => setAuth({ token: getToken(), user: getUser() });
    read();
    window.addEventListener("traceo-auth", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("traceo-auth", read);
      window.removeEventListener("storage", read);
    };
  }, []);

  useEffect(() => {
    void ensureSession();
  }, []);

  return (
    <>
      <header className="app-header">
        <Link href="/projects" className="brand">
          <span className="logo-tile" aria-hidden>
            T
          </span>
          <span className="wordmark">Traceo</span>
          <span className="brand-tagline">requirement → test → result</span>
        </Link>
        <div className="header-spacer" />
        <div className="header-right">
          {auth.user?.name && (
            <span className="header-user" title={auth.user?.email ?? ""}>
              {auth.user.name}
            </span>
          )}
        </div>
      </header>
      <main className="app-main">{children}</main>
    </>
  );
}
