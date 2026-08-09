/**
 * Entity state vocabularies — copied LITERALLY from backend/app/models.py (§5:
 * "قيم الحالة في data-state تُنسخ حرفياً من backend/app/models.py — لا مفردات موازية").
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

/** Job.status (backend/app/jobs.py — mirrored by backend-go/internal/jobs). */
export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Job.kind (backend/app/jobs.py — `submit(kind, …)`). `insight` is the sixth
 * engine's builder job: it follows the generation-job pattern exactly (202 →
 * `GET /v1/jobs/{id}`) but runs deterministic builders, never a model call.
 */
export const JOB_KINDS = ['ingest', 'generate', 'execute', 'report', 'insight'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * TestCase.technique — `edge_case` is the sixth engine's (QA Insight Agent)
 * value; the five others predate it and are unchanged.
 */
export const TEST_TECHNIQUES = [
  'ep',
  'bva',
  'decision_table',
  'negative',
  'manual',
  'edge_case',
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
 * category badge as data-state, never asserted through bilingual text.
 */
export const INSIGHT_STATUSES = ['covered', 'gap', 'n_a'] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

/** TestResult.outcome */
export const RESULT_OUTCOMES = ['passed', 'failed', 'errored'] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

/** SourceDocument.parse_status */
export const PARSE_STATUSES = ['pending', 'parsing', 'parsed', 'failed'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];
