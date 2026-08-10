/**
 * Typed error carrying the backend's uniform error shape
 * `{"detail": {"code", "message"}}` (§11) — negative specs assert on `code`.
 *
 * A few refusals carry a machine-readable payload ALONGSIDE the code — the
 * import validator's `errors` list, which names the formats actually supported
 * so the message is actionable. That payload is preserved verbatim in
 * `details`; specs still assert `code` first and treat `details` as extra
 * evidence, never as the contract's identity.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** The raw `detail` object of the response, when it was one. */
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** `detail.errors` as strings — [] when the refusal carried no list. */
  get errors(): string[] {
    const raw = this.details.errors;
    return Array.isArray(raw) ? raw.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))) : [];
  }
}
