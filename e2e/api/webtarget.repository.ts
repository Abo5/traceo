/**
 * Web-target repository — backend/app/modules/webtarget.py (and the Go parity
 * routes of the same names). One capability: point Traceo at a URL, tick test
 * types, and let a REAL BROWSER render the page before anything is persisted.
 *
 * Why a browser is not an implementation detail here: the motivating target
 * (the OrangeHRM demo login) answers a plain GET with ~3.4KB containing zero
 * forms, zero inputs and zero buttons. Server-side HTML parsing discovers
 * NOTHING on a client-rendered app, so the discovery sidecar
 * (tools/web-discovery/discover.mjs) is the only source of truth for what the
 * page contains — and when it is missing, the job must FAIL loudly with
 * `browser_discovery_unavailable` rather than report an empty success.
 *
 * Verified shapes (fixed contract §2):
 * - POST /projects/{id}/web-targets {url, viewport?, test_types[], auth?, max_pages?}
 *     -> 202 {job_id}; capability "import_spec"
 *     auth {username, password} is WRITE-ONLY: the target answers
 *     `auth_configured: true|false` and never the pair. A blank half of it is
 *     422 invalid_credentials; max_pages outside 1..50 is 422 invalid_max_pages
 *     with errors ["1","50"]; credentials the site rejects fail the JOB with
 *     error_code "login_failed" — which never says WHICH half was wrong, for
 *     the same reason identity.py answers a generic 401.
 *     unknown test type -> 422 {code:"invalid_test_type", errors:[legal list]}
 *     non-http(s) or private/loopback host -> the SSRF refusal the spec fetcher
 *     already applies (`invalid_url` / `ssrf_blocked`), unless the backend runs
 *     with TRACEO_ALLOW_PRIVATE_TARGETS=1
 * - GET  /projects/{id}/web-targets -> {"web_targets": [...]}          (view)
 * - GET  /web-targets/{id}          -> target + inventory summary      (view)
 * - GET  /web-targets/{id}/screenshot -> image/png bytes               (view)
 *   job result {target_id, title, forms, controls, requests, endpoints,
 *               requirements, cases_by_type, skipped:[{type, reason}]}
 */
import { ApiError } from './errors';
import type { TraceoHttp } from './http';
import type { JobPoller } from './job-poller';
import type {
  CredentialSource,
  Job,
  NewWebTarget,
  TestCase,
  WebTarget,
  WebTargetAccepted,
  WebTargetCrawlSummary,
  WebTargetDesign,
  WebTargetDetail,
  WebTargetForm,
  WebTargetInventory,
  WebTargetJobResult,
  WebTargetPageSkip,
  WebTargetRequest,
} from './types';

const POLL_INTERVAL_MS = 500;
/** Mirrors KIND_TIMEOUTS_MS.webtarget — browser launch + render + persistence. */
const SETTLE_TIMEOUT_MS = 240_000;

/**
 * How one discovery attempt ended. Three outcomes are LEGITIMATE and the spec
 * must be able to tell them apart, because they say different things:
 *
 * - `refused`   — the server would not even start (SSRF guard, bad scheme).
 *                 The guard working is itself a contract, so this is asserted,
 *                 not swallowed.
 * - `failed`    — the job ran and failed with a code. The one code the contract
 *                 names is `browser_discovery_unavailable`.
 * - `completed` — the browser rendered the page and the tracks persisted.
 *
 * Anything else (a job that fails with an unexplained error) is a defect and
 * the spec fails on it — this union exists to keep the interesting failure
 * modes visible, never to make a red run green.
 */
export type WebTargetDiscovery =
  | { kind: 'refused'; error: ApiError }
  // `accepted` is the 202 body, carried through because it is the FIRST place a
  // write-only credential could come back out, and re-creating the target just
  // to look at it would run a second crawl — which would break the "the login
  // form was submitted exactly once" assertion it was meant to support.
  | { kind: 'failed'; accepted: WebTargetAccepted; job: Job; code: string; error: string }
  | { kind: 'completed'; accepted: WebTargetAccepted; job: Job; result: WebTargetJobResult };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The machine-readable code of a failed job — `error_code` (jobs.py JobError)
 * when the backend sets it, otherwise the leading `code:` of the message. Read
 * this, never the sentence: the sentence is product copy (§6).
 */
export function failureCode(job: Job): string {
  if (typeof job.error_code === 'string' && job.error_code) return job.error_code;
  const raw = (job.error ?? '').trim();
  if (!raw) return '';
  const head = raw.split(/[\s:]/, 1)[0];
  return /^[a-z][a-z0-9_]*$/.test(head) ? head : raw;
}

export class WebTargetRepository {
  constructor(
    private readonly http: TraceoHttp,
    private readonly jobs: JobPoller,
  ) {}

  /** 202 flavour — {job_id, target_id, test_types} (capability "import_spec"). */
  async create(projectId: string, body: NewWebTarget): Promise<WebTargetAccepted> {
    return this.http.post<WebTargetAccepted>(`/projects/${projectId}/web-targets`, body);
  }

  async list(projectId: string): Promise<WebTarget[]> {
    const { web_targets } = await this.http.get<{ web_targets: WebTarget[] }>(
      `/projects/${projectId}/web-targets`,
    );
    return web_targets;
  }

  async get(targetId: string): Promise<WebTargetDetail> {
    return this.http.get<WebTargetDetail>(`/web-targets/${targetId}`);
  }

  /** The captured PNG — bytes, so the spec can assert it really is an image. */
  async screenshot(targetId: string): Promise<{ body: Buffer; contentType: string }> {
    return this.http.getBinary(`/web-targets/${targetId}/screenshot`);
  }

  /** Create and poll through the single waiting point, THROWING on failure. */
  async createAndWait(projectId: string, body: NewWebTarget): Promise<WebTargetJobResult> {
    const { job_id } = await this.create(projectId, body);
    const job = await this.jobs.waitFor(job_id, 'discover');
    return job.result as WebTargetJobResult;
  }

  /**
   * Create and poll to a TERMINAL state without throwing — the discovery job
   * is the one place in the suite where a failure is a legitimate observation
   * (no browser installed on this node) rather than an accident, and the spec
   * has to assert its shape. A timeout still throws: that is not an outcome,
   * it is a stuck job.
   */
  async createAndSettle(projectId: string, body: NewWebTarget): Promise<WebTargetDiscovery> {
    let accepted: WebTargetAccepted;
    try {
      accepted = await this.create(projectId, body);
    } catch (error) {
      if (error instanceof ApiError) return { kind: 'refused', error };
      throw error;
    }

    const started = Date.now();
    let last: Job | undefined;
    while (Date.now() - started < SETTLE_TIMEOUT_MS) {
      last = await this.http.get<Job>(`/jobs/${accepted.job_id}`);
      if (last.status === 'completed') {
        return {
          kind: 'completed',
          accepted,
          job: last,
          result: last.result as WebTargetJobResult,
        };
      }
      if (last.status === 'failed') {
        return {
          kind: 'failed',
          accepted,
          job: last,
          code: failureCode(last),
          error: last.error ?? '',
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `Web-target discovery job ${accepted.job_id} did not settle within ${SETTLE_TIMEOUT_MS}ms ` +
        `(last state: ${last?.status ?? 'never observed'}` +
        `${last?.message ? `, message: ${last.message}` : ''})`,
    );
  }
}

// --- inventory readers (no assertions — specs own those) ------------------------

/**
 * The inventory summary of a target, with every slice defaulted to an empty
 * list. A target that failed, or one discovered without a given track, simply
 * has nothing there — reading it must not be a special case at every call site.
 */
export function inventoryOf(detail: WebTargetDetail): WebTargetInventory {
  const inventory = detail.inventory ?? {};
  return {
    forms: inventory.forms ?? [],
    controls: inventory.controls ?? [],
    requests: inventory.requests ?? [],
    endpoints: inventory.endpoints ?? [],
    console_errors: inventory.console_errors ?? [],
    elapsed_ms: inventory.elapsed_ms ?? null,
    skipped: inventory.skipped ?? [],
  };
}

/** The design box of a target — palette, contrast findings, facts. */
export function designOf(detail: WebTargetDetail): WebTargetDesign {
  const design = detail.design ?? {};
  return {
    raster: design.raster ?? {},
    palette: design.palette ?? [],
    contrast: design.contrast ?? [],
    facts: design.facts ?? [],
    fact_count: design.fact_count ?? 0,
    failing_contrast: design.failing_contrast ?? 0,
  };
}

// --- the authenticated crawl ----------------------------------------------------

/**
 * The crawl summary of a target, with the two spellings of each count folded
 * into one. The JOB RESULT is the closed contract (`pages_visited`,
 * `pages_skipped`, `login`); the inventory's summary is the backend's own
 * echo of it, so it is read tolerantly and never used to prove a count on its
 * own.
 */
export function crawlOf(detail: WebTargetDetail): WebTargetCrawlSummary {
  const crawl = detail.inventory?.crawl ?? {};
  return {
    ...crawl,
    visited: crawl.visited ?? crawl.pages_visited,
    pages_visited: crawl.pages_visited ?? crawl.visited,
    skipped: crawl.skipped ?? crawl.pages_skipped ?? [],
    pages_skipped: crawl.pages_skipped ?? crawl.skipped ?? [],
    pages: crawl.pages ?? [],
  };
}

/**
 * Pages the run says it visited. A discovery that crawled nothing still visited
 * ONE page — the target itself — so a missing field reads as 1, never as 0: the
 * single-page contract is the same contract with a budget of one.
 */
export function pagesVisited(result: WebTargetJobResult): number {
  return typeof result.pages_visited === 'number' ? result.pages_visited : 1;
}

export function pagesSkipped(result: WebTargetJobResult): WebTargetPageSkip[] {
  return result.pages_skipped ?? [];
}

/**
 * Which account signed the crawl in — `null` when nothing did. The distinction
 * is the whole of the credential rule: `"user"` is a secret the run may not
 * describe any further, `"page"` is a fact the page itself published and a run
 * MUST be auditable for. A missing field is read as `null`, never as "user".
 */
export function credentialsSource(result: WebTargetJobResult): CredentialSource | null {
  return result.credentials_source ?? null;
}

/**
 * The "there is a login here and nothing could pass it" report, read tolerantly
 * because a backend may spell it as a flag beside its selectors or as one
 * object carrying both. What is NOT tolerated is the substance: `present`
 * without selectors is an apology, and the spec fails on it.
 */
export function loginRequirement(result: WebTargetJobResult): {
  present: boolean;
  selectors: string[];
  raw: unknown;
} {
  // Both engines carry it inside the login report as `required` beside the
  // form; a flag of its own is the other legal spelling. Either is read, and
  // neither excuses a report with no selectors in it.
  const nested = result.login && result.login.required ? result.login : null;
  const raw = result.login_required ?? nested;
  if (raw === null || raw === undefined || raw === false) {
    return { present: false, selectors: [], raw: raw ?? null };
  }
  // Read structurally: the two spellings are different declared types that
  // carry the same three facts, and widening one to the other would let a
  // future field of either be asserted on by accident.
  const marker = (typeof raw === 'object' ? raw : {}) as {
    selectors?: string[];
    form?: {
      selector?: string | null;
      fields?: Array<string | { selector?: string | null }>;
      submit?: string | null;
    } | null;
  };
  const selectors = new Set<string>(marker.selectors ?? []);
  if (marker.form?.selector) selectors.add(marker.form.selector);
  // A field arrives either as its selector or as the whole field object.
  for (const field of marker.form?.fields ?? []) {
    if (typeof field === 'string') selectors.add(field);
    else if (field?.selector) selectors.add(field.selector);
  }
  if (marker.form?.submit) selectors.add(marker.form.submit);
  return { present: true, selectors: [...selectors], raw };
}

/**
 * The pages one case cites. The artefact vocabulary fixes the spelling
 * `page:<final_url>` (docs/WEB_TARGETS.md §2), which is what makes "this case
 * came from a page the crawl never visited" a checkable statement rather than
 * an impression.
 */
export function citedPageUrls(testCase: TestCase): string[] {
  const haystack = JSON.stringify({
    title: testCase.title,
    description: testCase.description,
    preconditions: testCase.preconditions,
    steps: testCase.steps ?? [],
  });
  const cited = new Set<string>();
  for (const match of haystack.matchAll(/page:(https?:\/\/[^\s"'\\,)\]]+)/g)) {
    cited.add(match[1]);
  }
  return [...cited];
}

/**
 * Every encoding of a secret found anywhere in a payload — empty means clean.
 *
 * A password leak is not only a literal one: a value that travelled through a
 * query string arrives percent-encoded, and one that travelled through a header
 * or a stored blob can arrive base64'd. Checking the literal alone would pass a
 * payload that still hands the reader the password.
 */
export function secretTraces(payload: unknown, secret: string): string[] {
  const haystack = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  const encodings: Array<[string, string]> = [
    ['literal', secret],
    ['urlencoded', encodeURIComponent(secret)],
    ['base64', Buffer.from(secret, 'utf8').toString('base64')],
  ];
  return encodings
    .filter(([, encoded]) => encoded.length > 0 && haystack.includes(encoded))
    .map(([name]) => name);
}

/** Every selector the discovery reported — forms, their fields, and controls. */
export function discoveredSelectors(inventory: WebTargetInventory): string[] {
  const selectors: string[] = [];
  for (const form of inventory.forms ?? []) {
    if (form.selector) selectors.push(form.selector);
    for (const field of form.fields ?? []) {
      if (field.selector) selectors.push(field.selector);
    }
  }
  for (const control of inventory.controls ?? []) {
    if (control.selector) selectors.push(control.selector);
  }
  return [...new Set(selectors)];
}

/** Required fields of one form — what a functional case must name. */
export function requiredFieldSelectors(form: WebTargetForm): string[] {
  return (form.fields ?? []).filter((f) => f.required).map((f) => f.selector);
}

/**
 * Design fact ids (design.py `Fact.id` — "kind:subject"), from the facts list
 * and from the contrast findings, which carry the same ids. These are what a
 * UI case is allowed to cite, and nothing else is.
 */
export function designFactIds(design: WebTargetDesign): string[] {
  return [
    ...new Set([
      ...(design.facts ?? []).map((f) => f.id),
      ...(design.contrast ?? []).map((c) => c.fact_id),
    ]),
  ].filter(Boolean);
}

/** Contrast findings that fail WCAG AA — each carries the colour that passes. */
export function failingContrast(design: WebTargetDesign) {
  return (design.contrast ?? []).filter((c) => c.passes_aa === false);
}

/** Server-relative path of an absolute (or already relative) captured URL. */
export function requestPath(request: WebTargetRequest): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url.split('?')[0];
  }
}

/** "METHOD /path" of every captured request — the pre-templating traffic set. */
export function capturedKeys(inventory: WebTargetInventory): string[] {
  return [
    ...new Set(
      (inventory.requests ?? []).map((r) => `${r.method.toUpperCase()} ${requestPath(r)}`),
    ),
  ];
}

/** Captured requests the api track is expected to convert (XHR/fetch only). */
export function xhrRequests(inventory: WebTargetInventory): WebTargetRequest[] {
  return (inventory.requests ?? []).filter((r) => {
    const kind = (r.resourceType ?? r.resource_type ?? '').toLowerCase();
    return kind === 'xhr' || kind === 'fetch';
  });
}

// --- the grounding oracle -------------------------------------------------------
// Every case the discovery job persists must reference something the discovery
// ACTUALLY FOUND: a form-field selector, a captured request, or a design fact
// id. That is the same sentence as BO-07, applied to a new inventory — and it
// is the only reason to trust a case generated from a URL nobody wrote a spec
// for.

/** Everything a generated case is allowed to point at, in one bag. */
export interface GroundingOracle {
  /** Form, field and control selectors, verbatim from the discovery. */
  selectors: string[];
  /** Design fact ids extracted from the screenshot. */
  factIds: string[];
  /** "METHOD /path" of the endpoints persisted from the captured traffic. */
  endpointKeys: string[];
  /** Paths of those endpoints (templated), plus the target's own page path. */
  paths: string[];
  /** The target URL and its final URL — what a performance case names. */
  urls: string[];
}

/**
 * The discovered artefacts one case actually references.
 *
 * TWO kinds of match, because a step row has FIXED columns
 * (method/path/request/assertions — backend/app/models.py TestStep):
 *
 *  - STRUCTURAL, for endpoints. `method` and `path` live in separate columns,
 *    so "GET /api/v2/orders/{id}" never appears as one string anywhere; the
 *    pair is recomposed from the step and looked up in the inventory.
 *  - TEXTUAL, for everything else. A UI or functional case necessarily carries
 *    its selector or fact id INSIDE `request`/`assertions`, since there is no
 *    column for either. What matters is not where the token sits but that the
 *    discovery produced it — which is why a fabricated selector cannot pass:
 *    it is not in the oracle, so it matches nothing.
 */
export function caseAnchors(testCase: TestCase, oracle: GroundingOracle): string[] {
  const anchors = new Set<string>();

  for (const step of apiStepKeys(testCase)) {
    if (oracle.endpointKeys.includes(step.key)) anchors.add(step.key);
  }

  const haystack = JSON.stringify({
    title: testCase.title,
    description: testCase.description,
    preconditions: testCase.preconditions,
    steps: testCase.steps ?? [],
  });
  // Longest first: the most specific token that matches is the one worth
  // reporting in a failure message.
  const tokens = [...oracle.selectors, ...oracle.factIds, ...oracle.urls].sort(
    (a, b) => b.length - a.length,
  );
  for (const token of tokens) {
    if (token.length > 0 && haystack.includes(token)) anchors.add(token);
  }

  return [...anchors];
}

/**
 * API-shaped steps of a case: those that name an HTTP method AND a path. They
 * are held to the stricter rule — the pair must exist in the persisted
 * inventory (or be the target's own page path, which is what a performance
 * case measures) — so an invented endpoint cannot hide behind a selector match.
 */
export function apiStepKeys(testCase: TestCase): Array<{ order: number; key: string; path: string }> {
  return (testCase.steps ?? [])
    .filter((s) => typeof s.path === 'string' && s.path.startsWith('/'))
    .map((s) => ({
      order: s.order,
      key: `${String(s.method ?? '').toUpperCase()} ${s.path}`,
      path: s.path,
    }));
}
