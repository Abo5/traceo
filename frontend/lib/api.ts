"use client";

export const API = process.env.NEXT_PUBLIC_API || "http://localhost:8000/v1";

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

export function ensureSession(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (sessionBootstrap === null) {
    sessionBootstrap = (async () => {
      try {
        const res = await fetch(`${API}/auth/dev-session`, { method: "POST" });
        if (!res.ok) return false;
        const data = await res.json();
        if (!getToken()) {
          setToken(data.token);
          setUser(data.user);
        }
        return true;
      } catch {
        return false; // offline or endpoint absent
      }
    })();
  }
  return sessionBootstrap;
}

export async function api<T = any>(
  path: string,
  opts?: { method?: string; body?: any; form?: FormData }
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

/** Polls GET /jobs/{id} every 1s until completed/failed; resolves with job result, throws ApiError on failed. */
export async function pollJob(jobId: string, onProgress?: (j: any) => void): Promise<any> {
  // hard cap ~10 minutes to avoid infinite loops
  for (let i = 0; i < 600; i++) {
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
  throw new ApiError("job_timeout", "Timed out waiting for the job", 408);
}
