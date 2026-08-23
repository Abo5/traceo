"use client";

import React, { useState } from "react";
import { ApiError, login, register } from "@/lib/api";

/**
 * Sign-in and sign-up, on one screen.
 *
 * The two modes share a screen rather than living on separate routes because
 * this component IS the unauthenticated state of the app: it is rendered in
 * place of the shell whenever there is no session, so there is no route to
 * navigate to and no way to reach the app around it.
 *
 * Registration creates an organisation and its first user, who is an admin —
 * that is what POST /auth/register does, and the copy says so, because a person
 * signing up to JOIN a colleague's organisation would otherwise quietly create a
 * second empty one and wonder where everybody went.
 */
export default function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === "register";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    // Checked here as well as by the server: an 8-character rule that only the
    // server knows costs a round trip to discover and reads as a rejection.
    if (isRegister && password.length < 8) {
      setError("The password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      if (isRegister) {
        await register({ org_name: orgName, name, email, password });
      } else {
        await login(email, password);
      }
      onDone();
    } catch (err) {
      const e = err as ApiError;
      setError(
        e?.code === "network_error"
          ? "Could not reach the server. Check that the backend is running."
          : e?.message || "Something went wrong."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit} data-testid="auth-form">
        <div className="auth-brand">
          <span className="auth-mark">T</span>
          <div>
            <h1>Traceo</h1>
            <p>Trace requirements to executed tests.</p>
          </div>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!isRegister}
            className={!isRegister ? "on" : ""}
            onClick={() => { setMode("login"); setError(null); }}
            data-testid="auth-tab-login"
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isRegister}
            className={isRegister ? "on" : ""}
            onClick={() => { setMode("register"); setError(null); }}
            data-testid="auth-tab-register"
          >
            Create an organisation
          </button>
        </div>

        {isRegister && (
          <>
            <label className="auth-field">
              <span>Organisation name</span>
              <input
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                required
                autoComplete="organization"
                data-testid="auth-org"
              />
            </label>
            <label className="auth-field">
              <span>Your name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                data-testid="auth-name"
              />
            </label>
          </>
        )}

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            data-testid="auth-email"
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={isRegister ? "new-password" : "current-password"}
            minLength={isRegister ? 8 : undefined}
            data-testid="auth-password"
          />
          {isRegister && <em>At least 8 characters.</em>}
        </label>

        {error && (
          <p className="auth-error" role="alert" data-testid="auth-error">
            {error}
          </p>
        )}

        <button type="submit" className="auth-submit" disabled={busy} data-testid="auth-submit">
          {busy ? "Working…" : isRegister ? "Create organisation" : "Sign in"}
        </button>

        {isRegister && (
          <p className="auth-note">
            This creates a NEW organisation with you as its admin. To join one that
            already exists, ask an admin there to invite you instead.
          </p>
        )}
      </form>
    </div>
  );
}
