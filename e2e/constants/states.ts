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

/** Job.kind (backend/app/jobs.py). */
export const JOB_KINDS = ['ingest', 'generate', 'execute', 'report'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** TestResult.outcome */
export const RESULT_OUTCOMES = ['passed', 'failed', 'errored'] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

/** SourceDocument.parse_status */
export const PARSE_STATUSES = ['pending', 'parsing', 'parsed', 'failed'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];
