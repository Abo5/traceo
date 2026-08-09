/**
 * Wire types for the /v1 API. Field names were derived by READING the backend
 * serializers (backend/app/modules/*.py + backend/API_CONTRACT.md) — not guessed.
 */
import type { Role } from '../constants/roles';
import type {
  JobKind,
  JobStatus,
  ParseStatus,
  RequirementState,
  ResultOutcome,
  RunState,
  TestCaseState,
} from '../constants/states';

// --- identity (modules/identity.py `_user_payload`) --------------------------

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  locale: 'en' | 'ar';
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
  locale?: 'en' | 'ar';
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
  created_at: string;
}

// --- projects (modules/projects.py `_project_payload` / `_env_payload`) ------

export interface Project {
  id: string;
  name: string;
  /** Nullable — null until auto-detected from the first parsed document (autopilot contract). */
  language: 'en' | 'ar' | null;
  /** Autopilot mode — "auto" chains detect→confirm→generate; "manual" changes nothing. */
  automation: 'auto' | 'manual';
  status: 'active' | 'archived';
  created_at: string | null;
  updated_at: string | null;
}

export interface NewProject {
  name: string;
  /** Optional — omitted/null lets the backend auto-detect from the first parsed document. */
  language?: 'en' | 'ar' | null;
  /** Optional — server default is "auto"; test fixtures pin "manual" (see project.factory.ts). */
  automation?: 'auto' | 'manual';
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
  language: string;
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
  warnings: string[];
  diff: { added: string[]; removed: string[]; changed: string[] };
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
  source: string;
  observed_count: number;
  // FR-024 coverage fields merged in by GET /projects/{id}/endpoints
  test_count: number;
  covered_params_pct: number;
  last_outcome: ResultOutcome | null;
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
  technique: string;
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
  started_at: string | null;
  finished_at: string | null;
  counts: RunCounts;
  initiated_by: string;
  abort_reason: string | null;
  created_at: string | null;
  /** Present on GET /runs/{id} and GET /projects/{id}/runs. */
  display_id?: number | string | null;
}

export interface RunResult {
  id: string;
  test_case: { id: string; title: string; type: string; priority: string; state: TestCaseState };
  test_case_version: number;
  outcome: ResultOutcome;
  duration_ms: number;
  failure_reason: Record<string, unknown> | null;
  evidence: Array<Record<string, unknown>>;
  created_at: string | null;
}
