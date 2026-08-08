/**
 * Typed error carrying the backend's uniform error shape
 * `{"detail": {"code", "message"}}` (§11) — negative specs assert on `code`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}
