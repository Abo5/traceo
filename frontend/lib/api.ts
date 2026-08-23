"use client";

/**
 * The API origin is derived from the page's OWN origin rather than pinned to
 * localhost.
 *
 * "localhost" is only correct while the browser runs on the same machine as the
 * backend. Serve this app to any other device — a laptop opening it across the
 * LAN on the machine that hosts it — and a hard-coded localhost aims the browser
 * back at ITSELF. Every call then fails with a connection error that reads as
 * "the backend is down" when the backend is running perfectly, which is a
 * genuinely misleading symptom to debug.
 *
 * Reading the hostname off window.location makes the app follow however it was
 * actually reached — IP, hostname.local, or a DNS name — with no per-device
 * configuration and nothing to edit when DHCP moves the address. The protocol is
 * carried across too, so an https deployment does not fall back to http.
 *
 * NEXT_PUBLIC_API still overrides everything, for deployments where the API is on
 * a different host than the UI; NEXT_PUBLIC_API_PORT covers the common case where
 * it is the same host on a different port.
 */
const API_PORT = process.env.NEXT_PUBLIC_API_PORT || "8000";
export const API =
  process.env.NEXT_PUBLIC_API ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:${API_PORT}/v1`
    : `http://localhost:${API_PORT}/v1`);

const TOKEN_KEY = "traceo_token";
const USER_KEY = "traceo_user";

export class ApiError extends Error {
  code: string;
  status: number;
  /** Field-level detail lines the API attached to the error (e.g. 422 invalid_spec). */
  errors: string[];
  constructor(code: string, message: string, status: number, errors?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.errors = Array.isArray(errors)
      ? errors.map((e) => (typeof e === "string" ? e : e?.message ?? JSON.stringify(e)))
      : [];
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (t === null) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, t);
    window.dispatchEvent(new Event("traceo-auth"));
  } catch {
    /* ignore */
  }
}

/** Shell convenience: cached user profile (set on login/register). Extra export — screens may ignore. */
export function getUser(): any | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Shell convenience: persist user profile. Extra export — screens may ignore. */
export function setUser(u: any | null): void {
  if (typeof window === "undefined") return;
  try {
    if (u === null) window.localStorage.removeItem(USER_KEY);
    else window.localStorage.setItem(USER_KEY, JSON.stringify(u));
    window.dispatchEvent(new Event("traceo-auth"));
  } catch {
    /* ignore */
  }
}

/**
 * No-login mode: a backend running with TRACEO_DEV_AUTOLOGIN=1 hands out a
 * session without credentials. This resolves once, before the first request
 * goes out — otherwise every screen would fire its initial fetch while the
 * token is still in flight and fail with "Missing bearer token", which is a
 * race, not an authorisation problem. On any other backend the endpoint 404s,
 * nothing is stored, and normal authentication is untouched.
 *
 * The answer is "is this backend running without login", NOT "did we just mint a
 * token" — a reload already holding a token must still learn that login is gone,
 * or the shell would put the sign-out control back.
 */
let sessionBootstrap: Promise<boolean> | null = null;

/**
 * @param force Mint a NEW session and overwrite whatever is stored.
 *
 * Needed because a token expires (TRACEO_TOKEN_TTL_HOURS, 12h by default) while
 * it is still sitting in localStorage. The unforced path only mints when no
 * token exists, so a stale one used to pin the app to "Invalid or expired token"
 * for ever: every request carried the dead token, the 401 was surfaced, and a
 * reload changed nothing because a token was still present. In a build with no
 * sign-in screen there is nowhere for the user to go from there — the only
 * escape was clearing site data by hand.
 */
let bootstrapInFlight = false;

export function ensureSession(force = false): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  // A forced re-mint discards a COMPLETED result but never interrupts one already
  // in flight: a page load fires several requests at once, so an expired token
  // produces several simultaneous 401s. They must share one new session rather
  // than race to mint one each.
  if (force && !bootstrapInFlight) sessionBootstrap = null;
  if (sessionBootstrap === null) {
    bootstrapInFlight = true;
    sessionBootstrap = (async () => {
      try {
        const res = await fetch(`${API}/auth/dev-session`, { method: "POST" });
        if (!res.ok) return false;
        const data = await res.json();
        if (force || !getToken()) {
          setToken(data.token);
          setUser(data.user);
        }
        return true;
      } catch {
        return false; // offline or endpoint absent
      } finally {
        bootstrapInFlight = false;
      }
    })();
  }
  return sessionBootstrap;
}

// ---------------------------------------------------------------------------
// Credentialed authentication
//
// These are the real entry points: /auth/login and /auth/register mint a token
// against a password, unlike ensureSession above which asks a development-only
// endpoint for one without credentials. Both store the token and the profile
// through the same setters, so the shell reacts to a sign-in exactly as it
// reacts to a bootstrapped session and nothing downstream needs to know which
// of the two produced the session it is running on.
// ---------------------------------------------------------------------------

export type AuthResult = { token: string; user: any };

/** Sign in with an email and a password. Throws ApiError on bad credentials. */
export async function login(email: string, password: string): Promise<AuthResult> {
  // Deliberately NOT routed through api(): that helper bootstraps a session
  // before every call, which would attach a stale token to a sign-in and, worse,
  // silently retry a rejected one. A credential exchange must carry exactly the
  // credentials it was given and nothing else.
  const res = await postAuth("/auth/login", { email: email.trim(), password });
  setToken(res.token);
  setUser(res.user);
  return res;
}

/** Create an organisation and its first (admin) user, then sign them in. */
export async function register(body: {
  org_name: string;
  name: string;
  email: string;
  password: string;
}): Promise<AuthResult> {
  const res = await postAuth("/auth/register", {
    org_name: body.org_name.trim(),
    name: body.name.trim(),
    email: body.email.trim(),
    password: body.password,
    locale: "en",
  });
  setToken(res.token);
  setUser(res.user);
  return res;
}

/** Sign out: drop the session so the next load lands on the sign-in screen. */
export function logout(): void {
  resetSession();
}

async function postAuth(path: string, body: unknown): Promise<AuthResult> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    throw new ApiError("network_error", e?.message || "Could not reach the server", 0);
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = data && typeof data === "object" ? data.detail ?? data : data;
    throw new ApiError(
      (detail && detail.code) || `http_${res.status}`,
      (detail && (detail.message || detail.msg)) ||
        (typeof detail === "string" && detail ? detail : res.statusText) ||
        "Sign-in failed",
      res.status,
      detail && detail.errors
    );
  }
  if (!data?.token) {
    throw new ApiError("bad_response", "The server did not return a session token", res.status);
  }
  return data as AuthResult;
}

/**
 * Discard the stored session so the next call bootstraps a fresh one.
 *
 * This build has no sign-out control and no login screen, so a stored token
 * that the backend rejects — minted before the database was recreated, or
 * against a different signing key — would otherwise be permanent: every screen
 * shows "Invalid or expired token" forever and the user has no way to clear it.
 * Recovery has to be automatic because there is no manual path left.
 */
export function resetSession(): void {
  sessionBootstrap = null;
  setToken(null);
  setUser(null);
}

export async function api<T = any>(
  path: string,
  opts?: { method?: string; body?: any; form?: FormData },
  retriedAfterReset = false
): Promise<T> {
  const headers: Record<string, string> = {};
  if (!getToken()) await ensureSession();
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts?.form) {
    body = opts.form; // browser sets multipart boundary
  } else if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const method = opts?.method ?? (body !== undefined ? "POST" : "GET");

  let res: Response;
  try {
    res = await fetch(API + path, { method, headers, body });
  } catch (e: any) {
    throw new ApiError("network_error", e?.message || "Could not reach the server", 0);
  }

  let data: any = undefined;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  // A rejected token is thrown away and the request retried once with a fresh
  // session. Once only, and only for this code: a second 401 is a real refusal
  // and must surface, not loop. A FormData body cannot be replayed after the
  // fetch consumed it, so an upload reports the failure instead — the next
  // call, made with the cleared session, succeeds.
  if (res.status === 401 && !retriedAfterReset && !opts?.form) {
    const code = data?.detail?.code ?? data?.code;
    if (code === "invalid_token" && getToken()) {
      resetSession();
      if (await ensureSession()) return api<T>(path, opts, true);
    }
  }

  if (!res.ok) {
    const detail = data && typeof data === "object" ? data.detail ?? data : data;
    if (detail && typeof detail === "object") {
      throw new ApiError(
        detail.code || `http_${res.status}`,
        detail.message || detail.msg || res.statusText || "Unexpected error",
        res.status,
        detail.errors
      );
    }
    throw new ApiError(
      `http_${res.status}`,
      typeof detail === "string" && detail ? detail : res.statusText || "Unexpected error",
      res.status
    );
  }

  return data as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Hard ceiling on how long the UI will watch a job. This is a runaway guard, NOT
 * a statement about how long work should take, so it has to sit ABOVE every
 * server-side guard. When it sits below one, the UI reports "timed out" on a job
 * the backend is still happily running: the work completes, the results land in
 * the database, and the screen shows a failure for something that succeeded.
 *
 * The pipeline job is the long pole. Its browser-check sidecar alone is allowed
 * TRACEO_WEB_CHECK_TIMEOUT_S + 30s (930s by default), and discovery, generation
 * and the API checks run either side of it — so the ceiling has to clear the sum,
 * not just the sidecar. A page of 40+ cases, each re-rendered for isolation, runs
 * well past twenty minutes on modest hardware; 45 minutes leaves that room while
 * still bounding a genuinely wedged job.
 */
const JOB_POLL_CEILING_MS = 45 * 60 * 1000;

/** Polls GET /jobs/{id} every 1s until completed/failed; resolves with job result, throws ApiError on failed. */
export async function pollJob(jobId: string, onProgress?: (j: any) => void): Promise<any> {
  // Wall-clock, not an iteration count: every pass also waits on the request
  // itself, so a 600-iteration loop drifted well past the 10 minutes it claimed
  // and the real budget moved with server latency. A deadline says what it means.
  const deadline = Date.now() + JOB_POLL_CEILING_MS;
  while (Date.now() < deadline) {
    const j = await api<any>(`/jobs/${jobId}`);
    if (onProgress) onProgress(j);
    const state = j?.state ?? j?.status;
    if (state === "completed") return j?.result ?? j;
    if (state === "failed") {
      const err = j?.error;
      const msg =
        (err && typeof err === "object" ? err.message : err) || "The job failed";
      const code = (err && typeof err === "object" && err.code) || "job_failed";
      throw new ApiError(code, msg, 500);
    }
    if (state === "cancelled" || state === "aborted") {
      throw new ApiError("job_cancelled", "The job was cancelled", 409);
    }
    await sleep(1000);
  }
  // The job is not cancelled here — only this screen stopped watching it. The
  // backend runs it to completion, so the message must not imply the work died.
  throw new ApiError(
    "job_timeout",
    "Stopped waiting after 45 minutes — the job may still be running on the server. " +
      "Reload the page to pick up its result.",
    408
  );
}
