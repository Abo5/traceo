"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, setToken, setUser } from "@/lib/api";
import { Button, Field, Input } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ token: string; user: any }>("/auth/login", {
        body: { email: email.trim(), password },
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
    <div className="auth-wrap" data-testid="login-page-root">
      <div className="auth-card">
        <h1 className="auth-title">Log in</h1>
        <p className="auth-sub">
          Sign in to Traceo to trace your requirements to executed tests
        </p>

        <form
          onSubmit={submit}
          data-testid="login-form-root"
          style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 24 }}
        >
          <Field label="Email" testId="login-form-email-input">
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" testId="login-form-password-input">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {error && <div className="error-text" data-testid="login-form-error-text">{error}</div>}

          <Button type="submit" variant="primary" disabled={busy} testId="login-form-submit-button">
            {busy ? "Signing in…" : "Log in"}
          </Button>
        </form>

        <div style={{ marginTop: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Demo account
          </div>
          <div className="demo-hint">
            demo@traceo.sa
            <br />
            Demo1234!
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            fontSize: 13,
            color: "var(--text-secondary)",
            display: "flex",
            gap: 6,
          }}
        >
          <span>Don&apos;t have an account?</span>
          <Link
            href="/register"
            data-testid="login-register-link"
            style={{ color: "var(--accent)", fontWeight: 600 }}
          >
            Create account
          </Link>
        </div>
      </div>
    </div>
  );
}
