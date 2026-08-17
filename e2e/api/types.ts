/**
 * Wire types for the /v1 API. Field names were derived by READING the backend
 * serializers (backend/app/modules/*.py + backend/API_CONTRACT.md) — not guessed.
 */
import type { Role } from '../constants/roles';
import type {
  AiCriticality,
  ComponentSource,
  EdgeCategory,
  InsightStatus,
  JobKind,
  JobStatus,
  ParseStatus,
  RequirementState,
  ResultOutcome,
  RunKind,
  RunState,
  SpecFormat,
  TestCaseState,
  WebTargetTestType,
  WeaknessActivity,
  WeaknessSeverity,
} from '../constants/states';

// --- identity (modules/identity.py `_user_payload`) --------------------------

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  locale: string;
  organisation_id: string;
  created_at: string | null;
  /** Present on register/login/me responses only. */
  org_name?: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface RegisterBody {
  org_name: string;
  name: string;
  email: string;
  password: string;
}

export interface InviteBody {
  email: string;
  name: string;
  role: Role;
  /** identity.py InviteIn: the inviter sets the member's password directly (min 8 chars). */
  password: string;
}

// --- jobs (backend/app/jobs.py Job.to_dict) ----------------------------------

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  message: string;
  result: unknown;
  error: string | null;
  /**
   * Machine-readable failure code, set only when the job raised a JobError
   * (jobs.py). A bare error string cannot be branched on: "node: command not
   * found" and "the page timed out" need different sentences in front of a
   * user, and only the code knows which is which. Null on every other job.
   */
  error_code?: string | null;
  created_at: string;
}

// --- projects (modules/projects.py `_project_payload` / `_env_payload`) ------

export interface Project {
  id: string;
  name: string;
  /** Autopilot mode — "auto" chains confirm_all→generate; "manual" changes nothing. */
  automation: 'auto' | 'manual';
  /**
   * Which of the five kinds of testing this project is for. Always returned
   * non-empty and in canonical order; a project that declared nothing reads as
   * all five (backend/app/testtypes.py::project_test_types).
   */
  test_types: WebTargetTestType[];
  status: 'active' | 'archived';
  created_at: string | null;
  updated_at: string | null;
}

export interface NewProject {
  name: string;
  /** Optional — server default is "auto"; test fixtures pin "manual" (see project.factory.ts). */
  automation?: 'auto' | 'manual';
  /** Optional — omitted means all five. */
  test_types?: string[];
}

export interface Environment {
  id: string;
  project_id: string;
  name: string;
  base_url: string;
  auth_type: 'none' | 'api_key' | 'basic' | 'bearer' | 'oauth2_cc';
  variables: Record<string, unknown>;
  tls_strict: boolean;
  /** Secrets are write-only (auth_config on create/update); reads expose only this flag. */
  auth_config_masked: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * The environment an import DERIVED from the uploaded document, echoed on the
 * api-specs response as `environment_created` (null when none was created).
 *
 * Deliberately narrow — {id, name, base_url} and nothing else: it is a
 * confirmation line, not a second environments API. The full row is read back
 * through `projects.listEnvironments`.
 */
export interface CreatedEnvironment {
  id: string;
  name: string;
  /** Derived base URL — `base_url + endpoint.path` reconstructs the original URL. */
  base_url: string;
}

export interface NewEnvironment {
  name: string;
  base_url: string;
  auth_type?: Environment['auth_type'];
  /** Write-only, never echoed back. */
  auth_config?: Record<string, string> | null;
  variables?: Record<string, unknown>;
  tls_strict?: boolean;
}

// --- ingestion (modules/ingestion.py `_doc_dict` / `_req_dict`) ---------------

export interface SourceDocument {
  id: string;
  project_id: string;
  filename: string;
  mime_type: string;
  size: number;
  version: number;
  parse_status: ParseStatus;
  parse_error: string | null;
  created_at: string | null;
}

/** 202 body of POST /projects/{id}/documents. */
export interface UploadAccepted {
  job_id: string;
  document_id: string;
}

export interface Requirement {
  id: string;
  project_id: string;
  source_document_id: string | null;
  external_id: string;
  description: string;
  acceptance_criteria: string[];
  type: 'functional' | 'business_rule' | 'data' | 'interface' | 'non_functional';
  priority: string;
  state: RequirementState;
  version: number;
  source_location: Record<string, unknown>;
  source_text: string;
  confidence: number;
  content_hash: string;
  created_at: string | null;
  updated_at: string | null;
}

// --- discovery (modules/discovery.py import response / `_endpoint_dict`) ------

export interface ImportSpecResult {
  spec_id: string;
  version: number;
  endpoints_count: number;
  warnings: unknown[];
  diff: { added: string[]; removed: string[]; changed: string[] };

  // --- collection import (Postman / HAR / Insomnia) ---------------------------
  // The SAME endpoint gained a deterministic format detector; every key below
  // is additive — the four above keep their names and meanings.

  /** What the detector decided the uploaded document is. */
  format: SpecFormat;
  /** Flat counters mirroring `diff` (`updated` is `diff.changed`) + the inventory size. */
  added: number;
  updated: number;
  removed: number;
  total: number;
  /**
   * AI enrichment counters (contract §3). Enrichment is optional and gated on
   * the project's `automation: "auto"`; a project on "manual" — and any run
   * where the model failed or returned nothing usable — reports 0/0 and the
   * import still succeeds. `enrichment_discarded` counts items the validation
   * gate refused (an unknown method+path, a renamed param, anything not in the
   * deterministic inventory); those are NEVER persisted.
   */
  enriched: number;
  enrichment_discarded: number;
  /**
   * The environment derived from this document, or null.
   *
   * Non-null ONLY when the project had ZERO environments at import time AND a
   * base URL could be derived deterministically from the document itself. An
   * existing environment is never touched and never overwritten, and no host is
   * ever invented — "no derivable base URL" reports null, it does not guess.
   */
  environment_created: CreatedEnvironment | null;
}

export interface Endpoint {
  id: string;
  api_spec_id: string | null;
  project_id: string;
  method: string;
  path: string;
  operation_id: string;
  summary: string;
  parameters: Array<Record<string, unknown>>;
  request_schema: Record<string, unknown> | null;
  response_schemas: Record<string, unknown>;
  security: unknown[];
  tags: string[];
  excluded: boolean;
  /** Fidelity ladder — `spec | traffic | dom | postman` (constants/states.ts). */
  source: string;
  observed_count: number;
  // FR-024 coverage fields merged in by GET /projects/{id}/endpoints
  test_count: number;
  covered_params_pct: number;
  last_outcome: ResultOutcome | null;

  // --- AI enrichment (nullable, contract §3) ----------------------------------
  // Written only by the gated enrichment step, and only ever as ANNOTATIONS:
  // enrichment may not create, rename or delete an endpoint, nor touch a path,
  // a param or a field name. Null on every endpoint that was never enriched.

  /** One-line plain-English description. Plain text — never markup, never a locator. */
  ai_description: string | null;
  /** Resource group name the model proposed for this endpoint. */
  ai_group: string | null;
  /** high | medium | low — see AI_CRITICALITIES. */
  ai_criticality: AiCriticality | null;
}

// --- generation (modules/generation.py) ---------------------------------------

export type GenerationDepth = 'smoke' | 'standard' | 'exhaustive';

export interface GenerateBody {
  requirement_ids?: string[];
  depth?: GenerationDepth;
}

/** 202 body of POST /projects/{id}/generate. */
export interface JobAccepted {
  job_id: string;
}

/** Job.result of a completed `generate` job. */
export interface GenerationJobResult {
  generated: number;
  discarded: number;
  unmappable: Array<{ requirement_id: string; reason: string }>;
  duplicates: number;
}

// --- security (modules/security.py + data/weaknesses.json) --------------------
// S0 of docs/SECURITY_TESTING_PLAN.md: a shipped, versioned weakness catalogue,
// deterministic builders that reuse generation.py's case shape and its grounding
// gate, and the §11 coverage matrix. No model is involved anywhere in this
// surface — the catalogue is a data file and the builders are pure.

/** Standard references of one catalogue entry — the audit trail of the class. */
export interface WeaknessRefs {
  /** OWASP API Security Top 10 id, e.g. "API1:2023" — null for a CWE-only class. */
  owasp_api?: string | null;
  /** CWE ids, e.g. ["CWE-639"]. */
  cwe?: string[];
  /** OWASP ASVS verification requirement ids, e.g. ["4.2.1"]. */
  asvs?: string[];
}

/**
 * One weakness class of the shipped catalogue.
 *
 * `precondition` is a MACHINE-CHECKABLE object in a small closed vocabulary
 * (`path_has_parameter`, `declares_security`, `request_has_body`,
 * `has_string_field`, `always`, …) — the builder evaluates it against an
 * endpoint, which is what makes a skipped pair auditable rather than invisible.
 * Kept as an open record on the wire: the vocabulary is the backend's to grow,
 * and a spec asserts its EFFECT (a skip carries a reason) rather than its keys.
 */
export interface Weakness {
  /** Stable slug — the value that lands on `TestCase.weakness_id`. */
  id: string;
  title: string;
  refs: WeaknessRefs;
  /** Base severity, before endpoint context (§10). */
  severity: WeaknessSeverity;
  /** passive = safe to run by default; active = gated behind S1's flag (§7). */
  activity: WeaknessActivity;
  precondition: Record<string, unknown>;
  /** The assertion families the builder emits for this class. */
  checks: unknown[];
}

/** GET /weaknesses — the shipped corpus and its version (capability "view"). */
export interface WeaknessCatalogue {
  /** Stamped into every generated case; a change makes affected cases stale. */
  version: string;
  weaknesses: Weakness[];
}

/** POST /projects/{id}/security/generate — both filters optional. */
export interface SecurityGenerateBody {
  weakness_ids?: string[];
  requirement_ids?: string[];
}

/**
 * One (endpoint × weakness) pair the builder did NOT emit a case for, as
 * reported by the generation job. `reason` is REQUIRED — it is the whole point
 * of the entry, and "no mapped requirement" (BO-07) is one of its values.
 */
export interface SecuritySkip {
  /** "METHOD /path" of the endpoint, as the job reports it. */
  endpoint: string;
  weakness: string;
  reason: string;
}

/** Job.result of a completed security-generation job. */
export interface SecurityJobResult {
  generated: number;
  /** Candidates the grounding gate refused — counted, never persisted (BO-07). */
  discarded: number;
  skipped: SecuritySkip[];
}

/** A skipped pair as the coverage matrix reports it (identified, not stringly). */
export interface CoverageSkip {
  endpoint_id: string;
  method: string;
  path: string;
  weakness_id: string;
  reason: string;
}

/** The three buckets of §11, per weakness class. */
export interface CoverageByWeakness {
  weakness_id: string;
  covered: number;
  not_applicable: number;
  /** Applicable, no case — the number the report exists to surface. */
  gap: number;
}

/** GET /projects/{id}/security/coverage — the §11 matrix (capability "view"). */
export interface SecurityCoverage {
  /** The catalogue version the matrix was computed against. */
  corpus_version: string;
  pairs: { total: number; covered: number; not_applicable: number; gap: number };
  by_weakness: CoverageByWeakness[];
  skipped: CoverageSkip[];
}

// --- components — the SBOM inventory (modules/components.py) -------------------
// S2: without an inventory a CVE feed is news about other people's software
// (plan §2). Parsers are pure and offline; a version is NEVER invented —
// an unpinned line arrives with `version: null` and is counted as such.

export interface Component {
  id: string;
  project_id: string;
  name: string;
  /** null for an unpinned/ranged declaration — never guessed (plan §2). */
  version: string | null;
  ecosystem: string;
  /** Derived only where the ecosystem allows it deterministically. */
  cpe23: string | null;
  /** Fidelity order: sbom > lockfile > manual > fingerprint. */
  source: ComponentSource;
  status: string;
  purl?: string | null;
  /**
   * WHY this row has no version — set exactly when `version` is null (an
   * unpinned requirements line, an SBOM entry without one). "Never invent a
   * version" is only auditable if the absence is explained (plan §2).
   */
  unpinned_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Job.result of a completed component-import job. */
export interface ComponentImportResult {
  /** The detected manifest format — a member of the 422 refusal's `errors` list. */
  format: string;
  added: number;
  updated: number;
  /** Declarations recorded with `version: null` because they were not pinned. */
  unpinned: number;
  total: number;
}

// --- web targets (modules/webtarget.py + tools/web-discovery/discover.mjs) ----
// Point Traceo at a URL, tick the test types, and let a real browser render the
// page. Everything below describes ONE discovery: what the browser found, what
// was persisted from it, and what was deliberately not.
//
// The shapes are read defensively on purpose. The job result (§2 of the fixed
// contract) is a closed, fully specified object and is typed as such; the
// INVENTORY echoed by `GET /web-targets/{id}` is a summary whose nesting the
// backend owns, so the optional aliases below let the suite read it without
// pinning a key the contract never fixed. What the specs assert is the
// grounding relation, never the spelling.

/** One field of a discovered form — the selector is what a UI case must carry. */
export interface WebTargetField {
  /** CSS selector of the field, verbatim from the discovery. */
  selector: string;
  name?: string | null;
  id?: string | null;
  /** input type attribute (text, password, checkbox …). */
  type?: string | null;
  required?: boolean;
  placeholder?: string | null;
  /** Associated <label> text, when the page has one. */
  label?: string | null;
  maxlength?: number | null;
  pattern?: string | null;
}

/** One discovered form. `fields` is the inventory a functional case grounds in. */
export interface WebTargetForm {
  selector: string;
  name?: string | null;
  id?: string | null;
  action?: string | null;
  method?: string | null;
  fields: WebTargetField[];
}

/** A button or link the page exposes — never clicked by discovery, only read. */
export interface WebTargetControl {
  selector: string;
  /** button | link | … as the discovery reports it. */
  role?: string | null;
  /** Accessible name; `accessible_name` is tolerated as an alias. */
  name?: string | null;
  accessible_name?: string | null;
  href?: string | null;
}

/** One captured network request — the XHR/fetch inventory the api track uses. */
export interface WebTargetRequest {
  method: string;
  /** Absolute URL as the page requested it. */
  url: string;
  /** Normalised Playwright resourceType (`xhr`, `fetch`, `document`, …). */
  resource_type?: string | null;
  /** Raw camelCase spelling, tolerated when reading a sidecar document directly. */
  resourceType?: string | null;
  status?: number | null;
}

/** One operation the api track derived from the captured traffic. */
export interface WebTargetOperation {
  method: string;
  /** Templated path — concrete ids become `{id}` (collections.template_segment). */
  path: string;
  observed_count?: number;
  origins?: string[];
  statuses?: number[];
}

/** One palette entry of the design box: a surface colour and its share. */
export interface WebTargetPaletteEntry {
  hex: string;
  rgb?: number[];
  /** Fraction of the analysed raster this colour covers (0…1). */
  share: number;
  role?: string;
}

/**
 * One WCAG contrast finding, with the fix. `suggested` is
 * visual.nearest_accessible's colour — same hue and chroma, lightness only —
 * so it is recognisably the designer's colour rather than a different one that
 * happens to pass. `achievable: false` means the SURFACE has to change.
 */
export interface WebTargetContrastFinding {
  /** design.py `Fact.id` — "contrast:#INK_on_#SURFACE". */
  fact_id: string;
  ink: string;
  surface: string;
  ratio: number;
  passes_aa: boolean | null;
  passes_aa_large?: boolean | null;
  suggested: string;
  ratio_after: number;
  delta_e: number;
  achievable: boolean;
}

/** A design fact extracted from the screenshot (design.py `Fact.id` = kind:subject). */
export interface WebTargetDesignFact {
  id: string;
  kind?: string;
  statement?: string;
}

/** The design box — palette, contrast findings and the facts behind them. */
export interface WebTargetDesign {
  /** How the raster was derived (crop to viewport, subsample step, sizes). */
  raster?: Record<string, unknown>;
  palette?: WebTargetPaletteEntry[];
  contrast?: WebTargetContrastFinding[];
  facts?: WebTargetDesignFact[];
  fact_count?: number;
  failing_contrast?: number;
}

/**
 * One page the crawl decided NOT to visit, and why. The reason is the entry's
 * whole purpose: "12 pages skipped" is a number, "logout control" and "left the
 * origin" are the safety rule being observed doing its job.
 */
export interface WebTargetPageSkip {
  url: string;
  reason: string;
}

/**
 * How the sign-in went. `strategy` names WHICH success proof fired (the URL
 * left the login page, a logout control appeared, or the password field is
 * gone) — three different observations, and knowing which one was used is the
 * difference between a diagnosable crawl and a hopeful one.
 *
 * There is no field for the credentials here, and there must never be one.
 */
export interface WebTargetLoginOutcome {
  succeeded: boolean;
  strategy?: string | null;
  final_url?: string | null;
  /** Set when a sign-in gate was found that nothing could pass. */
  required?: boolean;
  /** The gate's own form, so the report names what would unlock the rest. */
  form?: WebTargetLoginFormRef | null;
}

/** The login form as the login report echoes it: selectors, nothing else. */
export interface WebTargetLoginFormRef {
  selector?: string | null;
  /** Field SELECTORS, verbatim from the rendered form. */
  fields?: string[];
  submit?: string | null;
}

/**
 * The crawl summary carried inside the inventory. Read defensively for the same
 * reason the rest of the inventory is (see the note above): the job RESULT is
 * the closed contract, this is the backend's own summary of it.
 */
export interface WebTargetCrawlSummary {
  /** What --max-pages was asked for, and what was actually reached. */
  requested_max_pages?: number;
  visited?: number;
  pages_visited?: number;
  skipped?: WebTargetPageSkip[];
  pages_skipped?: WebTargetPageSkip[];
  origin?: string;
  login?: WebTargetLoginOutcome;
  /** One entry per visited page — the per-page artefacts persistence stands on. */
  pages?: WebTargetCrawledPage[];
}

/** One page of a crawl, as the inventory summarises it. */
export interface WebTargetCrawledPage {
  url: string;
  final_url?: string | null;
  title?: string | null;
  depth?: number;
  elapsed_ms?: number | null;
  forms?: number | WebTargetForm[];
  controls?: number | WebTargetControl[];
  status?: number | null;
}

/** The discovered inventory summary of one target (detail responses only). */
export interface WebTargetInventory {
  forms?: WebTargetForm[];
  controls?: WebTargetControl[];
  requests?: WebTargetRequest[];
  /** The operations the api track derived — method + TEMPLATED path. */
  endpoints?: WebTargetOperation[];
  console_errors?: string[];
  /** Milliseconds the discovery render took — the performance baseline. */
  elapsed_ms?: number | null;
  skipped?: WebTargetSkip[];
  /** Present when the target was crawled beyond its first page. */
  crawl?: WebTargetCrawlSummary;
}

/** A web target as listed by GET /projects/{id}/web-targets. */
export interface WebTarget {
  id: string;
  project_id: string;
  url: string;
  /** e.g. "1280x800" — the viewport the screenshot was taken at. */
  viewport: string;
  /** discovered | failed | pending (constants/states.ts WEB_TARGET_STATUSES). */
  status: string;
  title: string | null;
  /** Where the navigation actually ended up (redirects included). */
  final_url: string | null;
  last_discovered_at: string | null;
  /** Whether a screenshot is stored — the bytes come from the screenshot route. */
  has_screenshot?: boolean;
  /** Why the status is "failed" (`code: message`), null otherwise. */
  error?: string | null;
  /** The types this target was last discovered with. */
  test_types?: string[];
  /** forms / controls / requests / api_requests / endpoints of that discovery. */
  counts?: Record<string, number>;
  created_at?: string | null;
  /**
   * WHETHER credentials are stored for this target — never which. The stored
   * pair is encrypted and write-only on the wire (backend/app/security.py
   * encrypt_secret), so this boolean is the entire read surface, and a spec
   * that finds anything more than a boolean here has found a leak.
   */
  auth_configured?: boolean;
  /** The crawl budget this target was last discovered with (1…50). */
  max_pages?: number;
}

/** GET /web-targets/{id} — the target plus its inventory summary and design box. */
export interface WebTargetDetail extends WebTarget {
  inventory?: WebTargetInventory;
  design?: WebTargetDesign;
}

/** POST /projects/{id}/web-targets. */
export interface NewWebTarget {
  url: string;
  viewport?: string;
  /**
   * Subset of WEB_TARGET_TEST_TYPES. Typed as `string[]`, deliberately: the
   * refusal path has to be able to send an illegal value without fighting the
   * type system (same rationale as InsightGenerateBody.categories).
   *
   * OPTIONAL since a project declares its own types: omitting it runs exactly
   * what the project is for.
   */
  test_types?: string[];
  /**
   * Credentials for the one form the crawler is allowed to submit. WRITE-ONLY:
   * they go in, and nothing ever reads them back out — the payload answers
   * `auth_configured` instead.
   *
   * Typed loosely on purpose, exactly like `test_types`: the refusal path has
   * to be able to send a blank username or password without fighting the type
   * system, since `invalid_credentials` is part of the contract.
   */
  auth?: { username?: string; password?: string };
  /** How many pages the crawl may visit, 1…50. Anything else is a 422. */
  max_pages?: number;
}

/**
 * 202 body of POST /projects/{id}/web-targets. The target row exists (status
 * "pending") the moment the job is accepted, so a job that dies never leaves
 * the user with nothing to look at — hence `target_id` alongside `job_id`.
 */
export interface WebTargetAccepted {
  job_id: string;
  target_id: string;
  /** The normalised, de-duplicated, canonically ordered type list. */
  test_types: string[];
}

/**
 * One test type the job did NOT produce anything for. `reason` is the whole
 * point of the entry — a track that silently produces nothing is
 * indistinguishable from a track that is broken.
 */
export interface WebTargetSkip {
  type: string;
  reason: string;
}

/** Job.result of a completed web-target discovery job (§2 of the contract). */
export interface WebTargetJobResult {
  target_id: string;
  title: string | null;
  /** What the browser found. */
  forms: number;
  controls: number;
  requests: number;
  /** What was persisted from it. */
  endpoints: number;
  requirements: number;
  /** Cases per selected test type — one key per REQUESTED type, zero included. */
  cases_by_type: Record<string, number>;
  /** Types that produced nothing, each with the reason why. */
  skipped: WebTargetSkip[];
  /** Candidates the grounding gate refused — counted, never persisted (BO-07). */
  discarded?: number;
  /** Planned cases that already existed — deduplicated, not persisted. */
  duplicates?: number;

  // --- the authenticated crawl (absent on a single-page discovery) ------------

  /** How many pages the crawl actually rendered. 1 when nothing was crawled. */
  pages_visited?: number;
  /** Pages the crawl refused to visit, each with the reason it refused. */
  pages_skipped?: WebTargetPageSkip[];
  /** How the sign-in went — absent entirely when no credentials were given. */
  login?: WebTargetLoginOutcome | null;
  /**
   * WHERE the credentials came from, never what they were:
   *
   *  - `"user"` — the operator supplied them. A SECRET: it appears in no
   *    payload, no error and no log, so this string is the only evidence a run
   *    used one.
   *  - `"page"` — the login screen published them about itself. A fact about
   *    the page, and therefore auditable: a reader has to be able to see that a
   *    crawl signed in with an account nobody handed it.
   *  - `null` — it signed in with nothing, because there was nothing to use.
   */
  credentials_source?: CredentialSource | null;
  /**
   * Present when a login page was found and NOTHING could sign in to it. It is
   * not a failure and not a licence to report the logged-out surface as the
   * product: the crawl says what it found, and names the form that would unlock
   * the rest.
   */
  login_required?: WebTargetLoginRequirement | boolean | null;
}

/** Provenance of the credentials one crawl used — never a value. */
export type CredentialSource = 'user' | 'page';

/**
 * "There is a login here and I could not pass it." The SELECTORS are the
 * substance: they are what turns an apology into something actionable, and they
 * are grounded in the same rendered form every other artefact is grounded in.
 */
export interface WebTargetLoginRequirement {
  /** Selectors of the login form and its fields, verbatim from the discovery. */
  selectors?: string[];
  /** The form itself, when the backend echoes the whole thing. */
  form?: WebTargetForm | null;
  /** Where the login form was found. */
  url?: string | null;
  /** Product copy — asserted on the code and the selectors, never on this (§6). */
  message?: string | null;
}

// --- insight — the sixth engine (QA Insight Agent) ---------------------------

/** One taxonomy row of GET /projects/{id}/insights. */
export interface InsightCategory {
  id: EdgeCategory;
  /** Non-archived cases of the project already belonging to this category. */
  covered_count: number;
  /** NEW cases the deterministic builders could ground right now (dry run). */
  suggestable_count: number;
  status: InsightStatus;
}

/** GET /projects/{id}/insights — deterministic, no job, capability "view". */
export interface InsightsSummary {
  categories: InsightCategory[];
  total_cases: number;
  total_covered: number;
  total_suggestable: number;
}

/**
 * POST /projects/{id}/insights/generate — capability "generate".
 * `categories` is required and non-empty; ids outside EDGE_CATEGORIES are
 * rejected with 422 {code: "invalid_category"} — hence `string[]`, so the
 * negative path can send an illegal id without fighting the type system.
 */
export interface InsightGenerateBody {
  categories: string[];
  requirement_ids?: string[];
}

/** Job.result of a completed insight-generation job (kind "insight"). */
export interface InsightJobResult {
  /** Cases persisted after the grounding gate — the wire name of the counter. */
  generated?: number;
  /** Alias tolerated: the audit entry calls the same counter `created`. */
  created?: number;
  /** Cases the grounding gate rejected — counted, never persisted (BO-07). */
  discarded: number;
  /** Planned cases that already existed — deduplicated, not persisted. */
  duplicates?: number;
  /** The categories the run was asked for. */
  categories?: string[];
  /** Per-category tally of what was persisted. */
  by_category?: Record<string, number>;
}

// --- review (modules/review.py `_case_dict` / `_case_detail`) -----------------

export interface RequirementLink {
  id: string;
  external_id: string;
  description: string;
}

export interface TestStep {
  id?: string;
  order: number;
  endpoint_id: string | null;
  method: string;
  path: string;
  request: Record<string, unknown>;
  assertions: Array<Record<string, unknown>>;
  extractions: Array<Record<string, unknown>>;
}

export interface TestCase {
  id: string;
  project_id: string;
  title: string;
  description: string;
  preconditions: string;
  type: 'positive' | 'negative' | 'boundary';
  priority: string;
  state: TestCaseState;
  generated: boolean;
  user_modified: boolean;
  model: string;
  prompt_version: string;
  /** ep | bva | decision_table | negative | manual | edge_case | security (constants/states.ts). */
  technique: string;
  /**
   * Insight taxonomy id — one of the 9 canonical ids for cases produced by the
   * QA Insight Agent, null for every other case (nullable column, present in
   * test-case payloads).
   */
  edge_category: EdgeCategory | null;
  /**
   * Weakness class id (`Weakness.id`) for cases produced by the security
   * builders, null for every other case. A security case still carries its
   * requirement links, so it appears in the traceability matrix like any other
   * case (plan §8).
   */
  weakness_id: string | null;
  version: number;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  links: RequirementLink[];
  step_count: number;
  created_at: string | null;
  updated_at: string | null;
  /** Detail responses only. */
  steps?: TestStep[];
  /** Detail alias of `links` (FR-REV-02). */
  requirements?: RequirementLink[];
}

/** POST /projects/{id}/test-cases (review.py CaseCreate) — requirement_ids MUST be non-empty. */
export interface NewTestCase {
  title: string;
  requirement_ids: string[];
  description?: string;
  preconditions?: string;
  type?: 'positive' | 'negative' | 'boundary';
  priority?: string;
  steps?: Array<Partial<TestStep>>;
}

export type BulkAction = 'approve' | 'reject';
export type RejectReasonCode = 'incorrect' | 'shallow' | 'duplicate' | 'other';

export interface BulkResult {
  action: BulkAction;
  processed: number;
  errors: Array<{ id: string; code?: string; message?: string }>;
}

// --- execution (modules/execution.py `_run_dict` + results) -------------------

/** 202 body of POST /projects/{id}/runs. */
export interface RunAccepted {
  job_id: string;
  run_id: string;
}

export interface RunCounts {
  total?: number;
  passed?: number;
  failed?: number;
  errored?: number;
}

export interface Run {
  id: string;
  project_id: string;
  environment_id: string;
  state: RunState;
  /**
   * functional | security | performance — so gates and reports can separate a
   * security run from a functional one (plan §8). Not null on the wire;
   * pre-existing runs read back as "functional" (the column default).
   */
  kind: RunKind;
  started_at: string | null;
  finished_at: string | null;
  counts: RunCounts;
  initiated_by: string;
  abort_reason: string | null;
  created_at: string | null;
  /** Present on GET /runs/{id} and GET /projects/{id}/runs. */
  display_id?: number | string | null;
}

/**
 * The request a step actually sent, as recorded (and redacted) by
 * execution.py `req_evidence`.
 *
 * `url` is the ABSOLUTE URL of the sent request — the environment's base URL
 * plus the step path after `{{var}}` interpolation AND `{name}` path binding,
 * with the query string the server built. It is the only place a run states
 * what it really requested, which makes it the oracle for path-parameter
 * binding (helpers/path-params.ts).
 */
export interface EvidenceRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Serialised request body, truncated to EVIDENCE_MAX_BYTES; null when there was none. */
  body: string | null;
}

export interface EvidenceResponse {
  status: number;
  /** A fixed allow-list of response headers, not the whole set. */
  headers: Record<string, string>;
  body: string | null;
}

/**
 * One step's evidence. Appended in step order, so index `i` is `steps[i]` of
 * the case — up to the halting step: execution stops at the first failed
 * assertion or transport error (FR-EXE-11), so a case can record FEWER
 * evidence entries than it has steps, never more and never reordered.
 */
export interface RunEvidence {
  request: EvidenceRequest;
  /** null when the transport failed before any response existed (outcome "errored"). */
  response: EvidenceResponse | null;
  elapsed_ms: number;
  assertions: Array<Record<string, unknown>>;
  /** Present only on a transport failure — the redacted diagnostic. */
  error?: string;
}

export interface RunResult {
  id: string;
  test_case: { id: string; title: string; type: string; priority: string; state: TestCaseState };
  test_case_version: number;
  outcome: ResultOutcome;
  duration_ms: number;
  failure_reason: Record<string, unknown> | null;
  evidence: RunEvidence[];
  created_at: string | null;
}
