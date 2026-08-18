/**
 * Postman v2.x collection reader — the INDEPENDENT ORACLE of the collection
 * import spec (§6: the oracle must not be the system under test).
 *
 * The importer converts a collection to an endpoint inventory server-side. To
 * prove it invented nothing, the spec needs a second, trustworthy answer to
 * "what is actually in this file?" — so this module re-derives the inventory
 * from the fixture in the test process, by walking the collection's own item
 * tree. It deliberately reimplements only the parts of the conversion rules the
 * assertions depend on, and it never calls the API.
 *
 * Rules mirrored from the import contract (§2, deterministic — no LLM):
 * - a `:param` path segment becomes `{param}`;
 * - `{{var}}` segments resolve from the collection variables when the value is
 *   a plain literal, otherwise they template to `{var}`;
 * - the leading base-url variable / absolute origin is stripped so paths are
 *   server-relative (`basePath` below carries the path part of that base URL,
 *   e.g. `/calendar/v3` — see `serverRelative`);
 * - query parameters come from `url.query`; headers are captured but are NOT
 *   query params;
 * - raw JSON bodies contribute their top-level field names (types inferred from
 *   the values — no invented fields);
 * - identical method+path requests deduplicate, merging their params and fields.
 *
 * It is also the oracle for the environment an import DERIVES from the document:
 * `baseUrl`/`baseUrlKey` are the base-url variable as the file declares it,
 * `absoluteUrl` is the URL a request actually addresses, and
 * `suggestedVariables()` re-derives the variables map the environment should
 * carry — with credential-looking names emptied, so a secret in the document is
 * never expected to travel anywhere.
 *
 * Deliberate asymmetry: `queryParams` keeps Postman's `disabled` (unchecked)
 * entries. The oracle's job is to bound what the importer is ALLOWED to
 * produce, so it must be a superset of what the file declares — including a
 * param the importer may reasonably skip. Assertions about params the importer
 * must KEEP name those params explicitly instead of comparing whole sets.
 *
 * Nothing here mutates the fixture: `e2e/test-data/` is reference data (§8).
 */
import * as fs from 'node:fs';
import { samplePath } from './test-data';

/** One deduplicated method+path of the collection, with everything merged in. */
export interface CollectionRequest {
  method: string;
  /** Templated, server-relative-with-base-path, e.g. `/calendars/{calendarId}/acl`. */
  path: string;
  /** `METHOD /path` — the identity key the inventory is diffed on. */
  key: string;
  /**
   * The request's own URL with the base-url variable resolved and `:param`
   * templated, query string excluded — e.g.
   * `https://www.googleapis.com/calendar/v3/calendars/{calendarId}/acl`.
   *
   * This is the URL the DOCUMENT declares, re-derived from the file. It is the
   * oracle for the derived environment: `base_url + endpoint.path` must
   * reproduce it exactly, whichever side of the split the importer chose to put
   * the base URL's own path prefix on.
   */
  absoluteUrl: string;
  /** Distinct `url.query` keys (disabled entries included — see header). */
  queryParams: string[];
  /** Top-level field names of raw JSON bodies, merged across duplicates. */
  bodyFields: string[];
  /** True when at least one contributing request carried a `raw` body of any kind. */
  hasRawBody: boolean;
  /** True when a raw body parsed to a JSON OBJECT — i.e. there are fields to infer. */
  hasJsonBody: boolean;
  /** Status codes of the saved response examples, if any. */
  responseCodes: number[];
}

export interface ParsedCollection {
  /** The collection's declared schema URL — what the format detector keys on. */
  schema: string;
  /** `info.name` — the document title the derived environment is named after. */
  title: string;
  /** Name of the base-url variable, e.g. `baseUrl` ('' when the file declares none). */
  baseUrlKey: string;
  /** Value of that variable, e.g. `https://www.googleapis.com/calendar/v3` (may be ''). */
  baseUrl: string;
  /** Path component of the base-url variable, e.g. `/calendar/v3` (may be ''). */
  basePath: string;
  /** Every collection variable as declared, in file order (values verbatim). */
  variables: Record<string, string>;
  /** Deduplicated method+path inventory, sorted by key. */
  requests: CollectionRequest[];
  /** Number of leaf requests BEFORE deduplication. */
  requestCount: number;
  /** Every `METHOD /path` key, sorted — the oracle set. */
  keys: string[];
  /** Every declared absolute URL, sorted — the oracle set for URL reconstruction. */
  absoluteUrls: string[];
}

interface RawItem {
  name?: string;
  item?: RawItem[];
  request?: RawRequest;
  response?: Array<{ code?: number }>;
}

interface RawRequest {
  method?: string;
  url?: RawUrl | string;
  body?: { mode?: string; raw?: string; options?: { raw?: { language?: string } } };
}

interface RawUrl {
  raw?: string;
  host?: string[] | string;
  path?: Array<string | { value?: string }>;
  query?: Array<{ key?: string; disabled?: boolean }>;
}

interface RawVariable {
  key?: string;
  value?: unknown;
}

/**
 * Names a base URL may be declared under, lowercased — the derivation
 * vocabulary, first match in file order wins. Mirrors the import contract; keep
 * the two in step or the oracle stops describing the product.
 */
const BASE_URL_KEYS = ['baseurl', 'base_url', 'url', 'host'];

/**
 * Variable names that look like a credential — a case-insensitive SUBSTRING
 * match, so `authToken`, `X-API-KEY` and `client_secret` all qualify. Such
 * variables are carried into a derived environment as KEYS WITH AN EMPTY VALUE:
 * the user fills them in, and the example value in the document is never copied
 * and never logged.
 */
const CREDENTIAL_HINTS = ['token', 'secret', 'key', 'password', 'auth', 'bearer', 'apikey'];

/** True when a variable name looks like a credential (see CREDENTIAL_HINTS). */
export function looksLikeCredential(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_HINTS.some((hint) => lower.includes(hint));
}

/** Collection variables as a flat map (last definition wins, as Postman does). */
function variableMap(variables: RawVariable[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of variables ?? []) {
    if (typeof v?.key === 'string' && (typeof v.value === 'string' || typeof v.value === 'number')) {
      map.set(v.key, String(v.value));
    }
  }
  return map;
}

/** The base-url variable — its name and value, or ['', ''] when there is none. */
function baseUrlEntry(vars: Map<string, string>): [string, string] {
  for (const [key, value] of vars) {
    if (BASE_URL_KEYS.includes(key.toLowerCase())) return [key, value];
  }
  return ['', ''];
}

/**
 * Path component of the collection's base URL, when the base URL is a plain
 * absolute origin+path (e.g. `https://www.googleapis.com/calendar/v3` →
 * `/calendar/v3`). Returns '' when there is no such variable.
 */
function basePathOf(baseUrl: string): string {
  if (!baseUrl) return '';
  try {
    const { pathname } = new URL(baseUrl);
    return pathname === '/' ? '' : pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

/**
 * The variables a derived environment should carry, per the import contract:
 * every collection variable EXCEPT the base-url one, with credential-looking
 * names emptied. Values of emptied keys are not returned anywhere.
 */
export function suggestedVariables(collection: ParsedCollection): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(collection.variables)) {
    if (key === collection.baseUrlKey) continue;
    out[key] = looksLikeCredential(key) ? '' : value;
  }
  return out;
}

/** `:param` → `{param}`; `{{var}}` → its literal value, or `{var}` if unresolved. */
function templateSegment(segment: string, vars: Map<string, string>): string {
  if (segment.startsWith(':')) return `{${segment.slice(1)}}`;
  const match = /^\{\{(.+)\}\}$/.exec(segment);
  if (match) {
    const resolved = vars.get(match[1]);
    return resolved !== undefined && !resolved.includes('://') ? resolved : `{${match[1]}}`;
  }
  return segment;
}

function pathOf(url: RawUrl | string | undefined, vars: Map<string, string>): string {
  if (!url) return '/';
  if (typeof url === 'string') {
    // Rare string form — take the path of the (possibly variable-prefixed) URL.
    const withoutOrigin = url.replace(/^\{\{[^}]+\}\}/, '').replace(/^[a-z]+:\/\/[^/]+/i, '');
    const [pathOnly] = withoutOrigin.split('?');
    const segments = pathOnly.split('/').filter(Boolean);
    return `/${segments.map((s) => templateSegment(s, vars)).join('/')}`;
  }
  const segments = (url.path ?? [])
    .map((s) => (typeof s === 'string' ? s : (s?.value ?? '')))
    .filter((s) => s.length > 0)
    .map((s) => templateSegment(s, vars));
  return `/${segments.join('/')}`;
}

/** Top-level property names of a raw JSON body — [] for any non-JSON body. */
function jsonBodyFields(body: RawRequest['body']): string[] {
  if (!body || body.mode !== 'raw' || typeof body.raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(body.raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

function mergeInto(target: string[], values: string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

/** Read + convert a collection fixture from `e2e/test-data/`. */
export function readPostmanCollection(fileName: string): ParsedCollection {
  const raw = JSON.parse(fs.readFileSync(samplePath(fileName), 'utf8')) as {
    info?: { schema?: string; name?: string };
    variable?: RawVariable[];
    item?: RawItem[];
  };

  const vars = variableMap(raw.variable);
  const [baseUrlKey, baseUrl] = baseUrlEntry(vars);
  const basePath = basePathOf(baseUrl);
  const byKey = new Map<string, CollectionRequest>();
  let requestCount = 0;

  const walk = (items: RawItem[] | undefined): void => {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) {
        walk(item.item); // folders nest arbitrarily deep
        continue;
      }
      if (!item.request) continue;
      requestCount += 1;

      const method = String(item.request.method ?? 'GET').toUpperCase();
      const path = pathOf(item.request.url, vars);
      const key = `${method} ${path}`;
      const url = typeof item.request.url === 'object' ? item.request.url : undefined;
      const queryParams = (url?.query ?? [])
        .filter((q) => typeof q?.key === 'string')
        .map((q) => q.key as string);
      const hasRawBody = item.request.body?.mode === 'raw';
      const bodyFields = jsonBodyFields(item.request.body);
      const responseCodes = (item.response ?? [])
        .map((r) => Number(r?.code))
        .filter((c) => Number.isFinite(c));

      const existing = byKey.get(key);
      if (existing) {
        mergeInto(existing.queryParams, queryParams);
        mergeInto(existing.bodyFields, bodyFields);
        existing.hasRawBody ||= hasRawBody;
        existing.hasJsonBody ||= bodyFields.length > 0;
        for (const code of responseCodes) {
          if (!existing.responseCodes.includes(code)) existing.responseCodes.push(code);
        }
      } else {
        byKey.set(key, {
          method,
          path,
          key,
          // The base URL as the file declares it, joined to the request's own
          // path — one trailing slash is dropped so the join stays a URL and
          // never grows a `//` segment the document does not contain.
          absoluteUrl: `${baseUrl.replace(/\/$/, '')}${path}`,
          queryParams: [...new Set(queryParams)],
          bodyFields: [...bodyFields],
          hasRawBody,
          hasJsonBody: bodyFields.length > 0,
          responseCodes: [...new Set(responseCodes)],
        });
      }
    }
  };
  walk(raw.item);

  const requests = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  return {
    schema: String(raw.info?.schema ?? ''),
    title: String(raw.info?.name ?? ''),
    baseUrlKey,
    baseUrl,
    basePath,
    variables: Object.fromEntries(vars),
    requests,
    requestCount,
    keys: requests.map((r) => r.key),
    absoluteUrls: [...new Set(requests.map((r) => r.absoluteUrl))].sort(),
  };
}

/**
 * Drop the collection's base-url PATH prefix from an imported path, so the two
 * sides of the grounding diff speak the same dialect.
 *
 * The contract says the base-url variable is stripped to make paths
 * server-relative, but a base URL may legitimately carry a path of its own
 * (`https://www.googleapis.com/calendar/v3`), and whether that prefix belongs
 * to the server or to the path is a spec-level decision — the OpenAPI importer
 * keeps `paths` verbatim and records the server separately. This normaliser
 * therefore accepts BOTH renderings and nothing else: it removes the known
 * prefix when present and leaves every other character untouched. It is not a
 * fuzzy matcher — no templated segment is stripped, no case is folded — so a
 * fabricated path can never normalise into an existing one.
 */
export function serverRelative(path: string, basePath: string): string {
  if (!basePath || !path.startsWith(`${basePath}/`)) return path;
  return path.slice(basePath.length);
}
