/**
 * TraceoHttp — the ONLY place API requests are built (§11). Wraps Playwright's
 * APIRequestContext, understands the backend's uniform error shape
 * `{"detail": {"code", "message"}}` and unwraps it into a typed ApiError.
 *
 * Auth is a Strategy (§4): JWT bearer for human actors, X-API-Key for the
 * public CI surface. The full API URL is built here because Playwright's
 * baseURL joining would drop the `/v1` prefix on absolute paths.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { ApiError } from './errors';

export type AuthStrategy =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'api_key'; key: string };

export interface MultipartFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

type Query = Record<string, string | number | boolean | undefined>;

export class TraceoHttp {
  constructor(
    private readonly ctx: APIRequestContext,
    /** API root including the /v1 prefix, e.g. http://localhost:8000/v1 */
    private readonly apiUrl: string,
    private readonly auth: AuthStrategy = { kind: 'none' },
  ) {}

  /** Same context, different credentials (auth Strategy seam). */
  withAuth(auth: AuthStrategy): TraceoHttp {
    return new TraceoHttp(this.ctx, this.apiUrl, auth);
  }

  async get<T>(path: string, params?: Query): Promise<T> {
    return this.unwrap<T>(await this.ctx.get(this.url(path, params), { headers: this.headers() }));
  }

  /**
   * GET a binary body (a PNG screenshot). Returns the bytes and the declared
   * content type rather than a parsed object: `unwrap` would turn a PNG into a
   * mangled string, and the point of asserting on a screenshot route is that
   * what comes back is really an image — magic bytes, not a JSON envelope.
   * Failures still surface as a typed ApiError through the same unwrapping.
   */
  async getBinary(path: string): Promise<{ body: Buffer; contentType: string; status: number }> {
    const res = await this.ctx.get(this.url(path), { headers: this.headers() });
    if (!res.ok()) {
      await this.unwrap<unknown>(res); // throws the typed refusal
    }
    return {
      body: await res.body(),
      contentType: res.headers()['content-type'] ?? '',
      status: res.status(),
    };
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.unwrap<T>(
      await this.ctx.post(this.url(path), { headers: this.headers(), data: body ?? {} }),
    );
  }

  /** Multipart upload — Playwright sets the boundary; auth header still applies. */
  async postMultipart<T>(path: string, file: MultipartFile): Promise<T> {
    return this.unwrap<T>(
      await this.ctx.post(this.url(path), { headers: this.headers(), multipart: { file } }),
    );
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.unwrap<T>(
      await this.ctx.patch(this.url(path), { headers: this.headers(), data: body }),
    );
  }

  async delete<T>(path: string): Promise<T> {
    return this.unwrap<T>(await this.ctx.delete(this.url(path), { headers: this.headers() }));
  }

  // --- internals --------------------------------------------------------------

  private url(path: string, params?: Query): string {
    const full = this.apiUrl + path;
    if (!params) return full;
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) qs.set(key, String(value));
    }
    const query = qs.toString();
    return query ? `${full}?${query}` : full;
  }

  private headers(): Record<string, string> {
    switch (this.auth.kind) {
      case 'bearer':
        return { Authorization: `Bearer ${this.auth.token}` };
      case 'api_key':
        return { 'X-API-Key': this.auth.key };
      default:
        return {};
    }
  }

  private async unwrap<T>(res: APIResponse): Promise<T> {
    const text = await res.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok()) {
      const detail =
        data && typeof data === 'object' ? ((data as Record<string, unknown>).detail ?? data) : data;
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const d = detail as Record<string, unknown>;
        throw new ApiError(
          typeof d.code === 'string' ? d.code : `http_${res.status()}`,
          typeof d.message === 'string' ? d.message : res.statusText(),
          res.status(),
          d, // preserved verbatim — e.g. the import validator's `errors` list
        );
      }
      if (Array.isArray(detail)) {
        // FastAPI/pydantic body-validation errors arrive as a list.
        throw new ApiError('validation_error', JSON.stringify(detail), res.status());
      }
      throw new ApiError(
        `http_${res.status()}`,
        typeof detail === 'string' && detail ? detail : res.statusText(),
        res.status(),
      );
    }

    return data as T;
  }
}
