"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API, getToken, getUser, setToken, setUser } from "@/lib/api";

export default function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();

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

  // Development auto-login: when the backend runs with TRACEO_DEV_AUTOLOGIN=1 it
  // hands out a session without credentials, so the login screen never appears.
  // On any other backend the endpoint 404s and normal login is untouched.
  useEffect(() => {
    if (getToken()) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/auth/dev-session`, { method: "POST" });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        setToken(data.token);
        setUser(data.user);
        if (window.location.pathname === "/login" || window.location.pathname === "/") {
          router.replace("/projects");
        }
      } catch {
        /* offline or endpoint absent — fall through to the login screen */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function logout() {
    setToken(null);
    setUser(null);
    router.push("/login");
  }

  return (
    <>
      <header className="app-header">
        <Link href={auth.token ? "/projects" : "/login"} className="brand">
          <span className="logo-tile" aria-hidden>
            T
          </span>
          <span className="wordmark">Traceo</span>
          <span className="brand-tagline">requirement → test → result</span>
        </Link>
        <div className="header-spacer" />
        <div className="header-right">
          {auth.token && (
            <>
              {auth.user?.name && (
                <span className="header-user" title={auth.user?.email ?? ""}>
                  {auth.user.name}
                </span>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                Log out
              </button>
            </>
          )}
        </div>
      </header>
      <main className="app-main">{children}</main>
    </>
  );
}
