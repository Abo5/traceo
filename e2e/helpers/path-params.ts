/**
 * Path-parameter binding — the test-side reading of a backend contract
 * (`_PATH_PARAM_RE` / `_bind_path_params` in backend/app/modules/execution.py,
 * mirrored by the Go port). Pure functions, no assertions: specs own the
 * expectations (§8, §11).
 *
 * The defect these exist to prevent, in the owner's own words: an inventory
 * stores paths as TEMPLATES (`/customers/{id}`), and a run that sends the
 * template literally requests
 *   GET https://host/calendars/%7BcalendarId%7D/events?calendarId=example
 * — a URL that cannot exist, so EVERY path-parameterised case 404s regardless
 * of what the system under test does. The bug is invisible to a spec that only
 * looks at outcomes (a 404 is a plausible test failure); it is only visible in
 * the recorded evidence URL, which is why these helpers read that URL.
 *
 * Two mechanisms share the brace character and must not be confused:
 * `{{var}}` is run-context interpolation (older, untouched), `{name}` is the
 * OpenAPI-style path placeholder handled here. The regex below is copied
 * character for character from the backend so the suite cannot drift into
 * accepting a laxer form than the product implements.
 */

/** Verbatim copy of the backend's `_PATH_PARAM_RE` source — SINGLE braces. */
const PATH_PARAM_SOURCE = '\\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\\}';

/** Literal-template debris that must never reach the wire — raw and percent-encoded. */
const TEMPLATE_MARKERS = ['{', '}', '%7B', '%7b', '%7D', '%7d'] as const;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the path carries at least one `{name}` placeholder.
 *
 * Inherits the backend's own overlap: `{{var}}` contains `{var}`, so an
 * uninterpolated variable reads as a placeholder here exactly as it does in
 * `_bind_path_params`. That is faithful, not a bug — the binder runs AFTER
 * interpolation, so anything still spelled `{{…}}` at that point is unresolved.
 * Inventory paths (`/customers/{id}`) never carry the double form.
 */
export function isTemplatedPath(path: string): boolean {
  return new RegExp(PATH_PARAM_SOURCE).test(path);
}

/** Placeholder names in the order they appear: `/orders/{id}/items/{sku}` → ["id","sku"]. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(new RegExp(PATH_PARAM_SOURCE, 'g'))].map((m) => m[1]);
}

/**
 * Template markers a string still carries — `[]` means it is fully bound.
 *
 * Returned rather than asserted so a failure message can name what was found;
 * both spellings are checked because the request builder percent-encodes the
 * path, which is how the production symptom actually looked
 * (`%7BcalendarId%7D`), while a request that never reached the wire records the
 * raw form.
 *
 * Callers pass a URL's PATH, not the whole URL — see `pathOf`.
 */
export function templateMarkersIn(value: string): string[] {
  return TEMPLATE_MARKERS.filter((marker) => value.includes(marker));
}

/**
 * The path component of a URL.
 *
 * The template-debris scan is deliberately confined to it: a brace inside a
 * QUERY value is legitimate test data (generated negatives inject payloads),
 * whereas a brace in the path is the defect itself. The other half of the
 * symptom — the value leaking into the query string — is pinned by name
 * instead, via `queryKeysOf`.
 */
export function pathOf(url: string): string {
  return new URL(url).pathname;
}

/**
 * The values a URL actually carries in the positions a template declares.
 *
 * The template is matched against the END of the URL's path, because the
 * environment's base URL contributes a prefix the template knows nothing about
 * (`/api/v2` + `/customers/{id}` → `/api/v2/customers/example`). Placeholders
 * capture one segment each (`[^/]+`), so a value containing an encoded slash
 * (`%2F`) still resolves to exactly one capture, and values are returned
 * DECODED so a spec compares against the step's own parameter value rather
 * than against a particular encoder's output.
 *
 * Throws when the path does not match the template at all — including the
 * unbound case, where the placeholder captures `%7Bid%7D` instead: that still
 * matches structurally and comes back as the literal `{id}`, which is what
 * makes the caller's equality assertion fail loudly instead of silently
 * passing.
 */
export function boundPathValues(template: string, url: string): Record<string, string> {
  let pattern = '';
  let cursor = 0;
  for (const match of template.matchAll(new RegExp(PATH_PARAM_SOURCE, 'g'))) {
    const at = match.index ?? 0;
    pattern += escapeRegExp(template.slice(cursor, at)) + '([^/]+)';
    cursor = at + match[0].length;
  }
  pattern += escapeRegExp(template.slice(cursor));

  const pathname = new URL(url).pathname;
  const matched = new RegExp(`${pattern}$`).exec(pathname);
  if (!matched) {
    throw new Error(`URL path "${pathname}" does not match the template "${template}" (from ${url})`);
  }

  const bound: Record<string, string> = {};
  pathParamNames(template).forEach((name, i) => {
    bound[name] = decodeURIComponent(matched[i + 1]);
  });
  return bound;
}

/** Query-parameter names present on a URL — a bound key must NOT be sent twice. */
export function queryKeysOf(url: string): string[] {
  return [...new URL(url).searchParams.keys()];
}
