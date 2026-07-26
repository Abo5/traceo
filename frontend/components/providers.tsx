"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { applyDocumentLang, useLang, useT } from "@/lib/i18n";
import { getToken, getUser, setToken, setUser } from "@/lib/api";
import { Pill } from "@/components/ui";

export default function Providers({ children }: { children: React.ReactNode }) {
  const { lang, setLang } = useLang();
  const t = useT();
  const router = useRouter();

  const [auth, setAuth] = useState<{ token: string | null; user: any | null }>({
    token: null,
    user: null,
  });

  // keep <html lang/dir> in sync with the language store
  useEffect(() => {
    applyDocumentLang(lang);
  }, [lang]);

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
          <span className="brand-tagline" dir="ltr">
            requirement → test → result
          </span>
        </Link>
        <div className="header-spacer" />
        <div className="header-right">
          <div className="row" style={{ gap: 4 }}>
            <Pill active={lang === "ar"} onClick={() => setLang("ar")}>
              AR
            </Pill>
            <Pill active={lang === "en"} onClick={() => setLang("en")}>
              EN
            </Pill>
          </div>
          {auth.token && (
            <>
              {auth.user?.name && (
                <span className="header-user" title={auth.user?.email ?? ""}>
                  {auth.user.name}
                </span>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                {t("logout")}
              </button>
            </>
          )}
        </div>
      </header>
      <main className="app-main">{children}</main>
    </>
  );
}
