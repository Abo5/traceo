"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, setToken, setUser } from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { Button, Field, Input } from "@/components/ui";

export default function RegisterPage() {
  const router = useRouter();
  const { lang } = useLang();
  const ar = lang === "ar";

  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ token: string; user: any }>("/auth/register", {
        body: {
          org_name: orgName.trim(),
          name: name.trim(),
          email: email.trim(),
          password,
          locale: lang,
        },
      });
      setToken(res.token);
      setUser(res.user);
      router.push("/projects");
    } catch (err: any) {
      setError(err?.message || String(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1 className="auth-title">{ar ? "إنشاء حساب" : "Create account"}</h1>
        <p className="auth-sub">
          {ar
            ? "أنشئ منشأتك وابدأ بتحويل المتطلبات إلى اختبارات منفّذة"
            : "Create your organisation and turn requirements into executed tests"}
        </p>

        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 24 }}
        >
          <Field label={ar ? "اسم المنشأة" : "Organisation name"}>
            <Input
              required
              maxLength={200}
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
          </Field>
          <Field label={ar ? "الاسم" : "Name"}>
            <Input
              required
              maxLength={200}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={ar ? "البريد الإلكتروني" : "Email"}>
            <Input
              type="email"
              dir="ltr"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field
            label={ar ? "كلمة المرور" : "Password"}
            hint={ar ? "8 أحرف على الأقل" : "At least 8 characters"}
          >
            <Input
              type="password"
              dir="ltr"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {error && <div className="error-text">{error}</div>}

          <Button type="submit" variant="primary" disabled={busy}>
            {busy
              ? ar
                ? "جارٍ الإنشاء…"
                : "Creating…"
              : ar
                ? "إنشاء حساب"
                : "Create account"}
          </Button>
        </form>

        <div
          style={{
            marginTop: 18,
            fontSize: 13,
            color: "var(--text-secondary)",
            display: "flex",
            gap: 6,
          }}
        >
          <span>{ar ? "لديك حساب بالفعل؟" : "Already have an account?"}</span>
          <Link href="/login" style={{ color: "var(--accent)", fontWeight: 600 }}>
            {ar ? "تسجيل الدخول" : "Log in"}
          </Link>
        </div>
      </div>
    </div>
  );
}
