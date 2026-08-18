/**
 * Entity state vocabularies — copied LITERALLY from backend/app/models.py (§5:
 * state values carried in data-state are copied verbatim from
 * backend/app/models.py — no parallel vocabulary).
 */

/** Requirement.state */
export const REQUIREMENT_STATES = ['extracted', 'confirmed', 'changed', 'removed'] as const;
export type RequirementState = (typeof REQUIREMENT_STATES)[number];

/** TestCase.state */
export const TEST_CASE_STATES = ['draft', 'approved', 'rejected', 'stale', 'archived'] as const;
export type TestCaseState = (typeof TEST_CASE_STATES)[number];

/** Run.state */
export const RUN_STATES = ['queued', 'running', 'completed', 'cancelled', 'aborted'] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * Run.kind — added with the security track (docs/SECURITY_TESTING_PLAN.md §8/S0.4).
 * Not null, default "functional": every run that existed before the column, and
 * every ordinary run afterwards, reads back as functional.
 */
export const RUN_KINDS = ['functional', 'security', 'performance'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** Job.status (backend/app/jobs.py — mirrored by backend-go/internal/jobs). */
export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Job.kind (backend/app/jobs.py — `submit(kind, …)`). `insight` is the sixth
 * engine's builder job: it follows the generation-job pattern exactly (202 →
 * `GET /v1/jobs/{id}`) but runs deterministic builders, never a model call.
 */
export const JOB_KINDS = [
  'ingest',
  'generate',
  'execute',
  'report',
  'insight',
  // S0/S2 of the security track: the security builders and the component-manifest
  // parsers both follow the 202 → GET /v1/jobs/{id} pattern.
  'security',
  'components',
  // Browser discovery of a web target (jobs.submit("discover", …)): render the
  // URL in a real browser, then persist per selected test type. It is the
  // longest job in the product — a navigation, a network-idle wait and a
  // full-page screenshot before any builder runs — hence its own budget in
  // job-poller.ts. No spec asserts the string; it selects a budget.
  'discover',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * TestCase.technique — `edge_case` is the sixth engine's (QA Insight Agent)
 * value and `security` is the weakness-class builders' (S0.2); the five others
 * predate both and are unchanged.
 */
export const TEST_TECHNIQUES = [
  'ep',
  'bva',
  'decision_table',
  'negative',
  'manual',
  'edge_case',
  'security',
  // Parity with backend/app/models.py TECHNIQUES — `localisation` is the FR-034
  // Unicode round-trip probe and predates this list; it was simply missing here.
  'localisation',
  // Web-target tracks. `design`/`a11y` come from design.ui_cases (structural
  // facts and contrast findings, each carrying its design fact id); the
  // `performance` case carries the observed page-load baseline it is measured
  // against. All three joined models.py TECHNIQUES with the web-target feature.
  'design',
  'a11y',
  'performance',
  // A behaviour the model proposed for a crawled screen and the grounding gate
  // admitted. Apart from the deterministic techniques on purpose: it is the one
  // kind whose EXPECTATION nothing verified — only its targets were checked.
  'scenario',
] as const;
export type TestTechnique = (typeof TEST_TECHNIQUES)[number];

/**
 * TestCase.edge_category — the 9 canonical ids of the insight taxonomy
 * (nullable column: null for every case that is not an insight case). The
 * SAME strings are served by both backends and rendered by the insights page,
 * so this array is also the row-count guard of the UI (§5: one vocabulary).
 */
export const EDGE_CATEGORIES = [
  'boundary_surprise',
  'exotic_input',
  'control_chars',
  'idempotency',
  'state_corruption',
  'permission_edge',
  'timing_dst',
  'resource_exhaustion',
  'downstream_failure',
] as const;
export type EdgeCategory = (typeof EDGE_CATEGORIES)[number];

/**
 * Per-category status of GET /projects/{id}/insights — a pure function of the
 * two counters: covered (covered_count>0) | gap (0 covered, >0 suggestable) |
 * n_a (nothing in the inventory to ground the category in). Carried on the
 * category badge as data-state, never asserted through visible copy.
 */
export const INSIGHT_STATUSES = ['covered', 'gap', 'n_a'] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

/**
 * Detected import format of `POST /projects/{id}/api-specs` — the deterministic
 * format detector's closed vocabulary, echoed on the import response as
 * `format` and rendered by the endpoints page. `openapi3`/`swagger2` predate
 * the collection importer; the three others were added with it.
 */
export const SPEC_FORMATS = ['openapi3', 'swagger2', 'postman2', 'har', 'insomnia4'] as const;
export type SpecFormat = (typeof SPEC_FORMATS)[number];

/**
 * Endpoint.source — the fidelity ladder of the inventory, highest first
 * (`spec > traffic > dom > postman`): a later, higher-fidelity import wins over
 * collection-derived data for the same method+path and never deletes it.
 * Postman/Insomnia collections land as `postman`, HAR captures as `traffic`.
 */
export const ENDPOINT_SOURCES = ['spec', 'traffic', 'dom', 'postman'] as const;
export type EndpointSource = (typeof ENDPOINT_SOURCES)[number];

/**
 * The five test types a web target may be created with — the closed list of
 * `POST /projects/{id}/web-targets` `test_types`, and the legal list the 422
 * `invalid_test_type` refusal must name. One string per checkbox on the target
 * page (`target-type-{type}`), so this array is also the UI's row-count guard
 * (§5: one vocabulary, not two).
 */
export const WEB_TARGET_TEST_TYPES = [
  'functional',
  'api',
  'ui',
  'performance',
  'security',
] as const;
export type WebTargetTestType = (typeof WEB_TARGET_TEST_TYPES)[number];

/**
 * WebTarget.status — `pending` while the browser job runs, then `discovered`
 * or `failed`. A failed discovery keeps its row: "we tried this URL and could
 * not read it" is information, and deleting it would make the failure
 * invisible (the same reason a skipped pair keeps its reason).
 */
export const WEB_TARGET_STATUSES = ['pending', 'discovered', 'failed'] as const;
export type WebTargetStatus = (typeof WEB_TARGET_STATUSES)[number];

/**
 * Endpoint.ai_criticality — the ONLY enumerated field the optional AI
 * enrichment layer may write. Anything outside this list must have been
 * discarded by the validation gate before it reached the row.
 */
export const AI_CRITICALITIES = ['high', 'medium', 'low'] as const;
export type AiCriticality = (typeof AI_CRITICALITIES)[number];

/**
 * Weakness.severity — the class's BASE severity, before endpoint context
 * (docs/SECURITY_TESTING_PLAN.md §10 adjusts it per finding; the catalogue
 * entry itself carries only this).
 */
export const WEAKNESS_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type WeaknessSeverity = (typeof WEAKNESS_SEVERITIES)[number];

/**
 * Weakness.activity — the safety tag of §7. `passive` classes (headers, error
 * shapes, authz reads) are safe by default; `active` ones (writes, rate-limit
 * floods, oversize payloads) are GENERATED by S0 but must not be EXECUTED until
 * S1's per-environment authorisation flag exists.
 */
export const WEAKNESS_ACTIVITIES = ['passive', 'active'] as const;
export type WeaknessActivity = (typeof WEAKNESS_ACTIVITIES)[number];

/**
 * Component.source — the fidelity ladder of the inventory, highest first
 * (`sbom > lockfile > manual > fingerprint`, plan §2). A fingerprint is a hint
 * and never a version, which is why it sits at the bottom.
 */
export const COMPONENT_SOURCES = ['sbom', 'lockfile', 'manual', 'fingerprint'] as const;
export type ComponentSource = (typeof COMPONENT_SOURCES)[number];

/** TestResult.outcome */
export const RESULT_OUTCOMES = ['passed', 'failed', 'errored'] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

/** SourceDocument.parse_status */
export const PARSE_STATUSES = ['pending', 'parsing', 'parsed', 'failed'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];
