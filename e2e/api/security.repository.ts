/**
 * Security repository — S0 of docs/SECURITY_TESTING_PLAN.md.
 * Python: backend/app/modules/security.py + backend/app/data/weaknesses.json;
 * Go: the parity routes of the same names. Nothing on this surface calls a
 * model: the catalogue is a shipped data file and the builders are pure, so the
 * whole track stays deterministic and offline (NFR-D1).
 *
 * Verified shapes (fixed contract S0.3):
 * - GET  /weaknesses — capability "view", NO job
 *     -> {version, weaknesses: [{id, title, refs, severity, activity,
 *                                precondition, checks}]}
 * - POST /projects/{id}/security/generate — capability "generate"
 *     {weakness_ids?, requirement_ids?} -> 202 {job_id}
 *     job result {generated, discarded, skipped: [{endpoint, weakness, reason}]}
 *   The cases it persists are ORDINARY test cases: the same dict shape as
 *   generation.py's, technique "security", `weakness_id` set, >=1 requirement
 *   link, and every one of them past `generation.grounding_validate` — so
 *   review, approval and the traceability matrix treat them identically.
 * - GET  /projects/{id}/security/coverage — capability "view", NO job
 *     -> {corpus_version, pairs: {total, covered, not_applicable, gap},
 *         by_weakness: [...], skipped: [{endpoint_id, method, path,
 *         weakness_id, reason}]}
 */
import type { JobPoller } from './job-poller';
import type { TraceoHttp } from './http';
import type {
  Job,
  JobAccepted,
  SecurityCoverage,
  SecurityGenerateBody,
  SecurityJobResult,
  TestCase,
  Weakness,
  WeaknessCatalogue,
} from './types';

/** What one security-generation run produced — its counters AND the queue it left. */
export interface SecurityRunOutcome {
  result: SecurityJobResult;
  /** Every test case of the project after the run (drafts included). */
  cases: TestCase[];
}

export class SecurityRepository {
  constructor(
    private readonly http: TraceoHttp,
    private readonly jobs: JobPoller,
  ) {}

  /** The shipped weakness corpus. Org-independent — it is a file, not a table. */
  async catalogue(): Promise<WeaknessCatalogue> {
    return this.http.get<WeaknessCatalogue>('/weaknesses');
  }

  /** 202 flavour — returns {job_id} immediately. */
  async generate(projectId: string, body: SecurityGenerateBody = {}): Promise<JobAccepted> {
    return this.http.post<JobAccepted>(`/projects/${projectId}/security/generate`, body);
  }

  /**
   * Start a run, poll its job through the single waiting point (§16), and return
   * BOTH the counters and the resulting queue: a second run over the same pairs
   * is a deduplicated (and therefore different) population, so a spec must be
   * able to assert counters and cases against one and the same run.
   *
   * The kind passed to the poller selects a BUDGET, not an assertion — the job's
   * own kind is whatever the backend submitted it as.
   */
  async generateAndWait(
    projectId: string,
    body: SecurityGenerateBody = {},
  ): Promise<SecurityRunOutcome> {
    const { job_id } = await this.generate(projectId, body);
    const job: Job = await this.jobs.waitFor(job_id, 'security');
    const { test_cases } = await this.http.get<{ test_cases: TestCase[] }>(
      `/projects/${projectId}/test-cases`,
    );
    return { result: job.result as SecurityJobResult, cases: test_cases };
  }

  /** The §11 matrix. Deterministic and synchronous — no job. */
  async coverage(projectId: string): Promise<SecurityCoverage> {
    return this.http.get<SecurityCoverage>(`/projects/${projectId}/security/coverage`);
  }
}

// --- read helpers (no assertions — specs own those) -----------------------------

/** The catalogue as a set of class ids — the closed list every id must belong to. */
export function weaknessIds(catalogue: WeaknessCatalogue): string[] {
  return catalogue.weaknesses.map((w) => w.id);
}

/** Classes that are safe to run by default (§7) — the whole of S0's executable scope. */
export function passiveWeaknesses(catalogue: WeaknessCatalogue): Weakness[] {
  return catalogue.weaknesses.filter((w) => w.activity === 'passive');
}

/**
 * Cases produced by the security builders, identified by the technique the
 * contract fixes — never by title text, which is product copy.
 */
export function securityCases(cases: TestCase[]): TestCase[] {
  return cases.filter((c) => c.technique === 'security');
}
