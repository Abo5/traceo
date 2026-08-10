"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, setToken, setUser } from "@/lib/api";
import { Button, Field, Input } from "@/components/ui";

export default function RegisterPage() {
  const router = useRouter();

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
    <div className="auth-wrap" data-testid="register-page-root">
      <div className="auth-card">
        <h1 className="auth-title">Create account</h1>
        <p className="auth-sub">
          Create your organisation and turn requirements into executed tests
        </p>

        <form
          onSubmit={submit}
          data-testid="register-form-root"
          style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 24 }}
        >
          <Field label="Organisation name" testId="register-form-org-name-input">
            <Input
              required
              maxLength={200}
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
          </Field>
          <Field label="Name" testId="register-form-name-input">
            <Input
              required
              maxLength={200}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Email" testId="register-form-email-input">
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field
            label="Password"
            hint="At least 8 characters"
            testId="register-form-password-input"
          >
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {error && <div className="error-text" data-testid="register-form-error-text">{error}</div>}

          <Button type="submit" variant="primary" disabled={busy} testId="register-form-submit-button">
            {busy ? "Creating…" : "Create account"}
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
          <span>Already have an account?</span>
          <Link
            href="/login"
            data-testid="register-login-link"
            style={{ color: "var(--accent)", fontWeight: 600 }}
          >
            Log in
          </Link>
        </div>
      </div>
    </div>
  );
}
