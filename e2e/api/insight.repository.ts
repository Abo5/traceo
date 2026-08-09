/**
 * Insight repository — the sixth engine (QA Insight Agent / وكيل الرؤى).
 * Python: backend/app/modules/insight.py; Go: the parity route of the same
 * name (backend-go/GO_CONTRACT.md). The engine is 100% deterministic and
 * offline — no LLM call — so nothing here needs a mock-provider seam.
 *
 * Verified shapes (fixed contract §C/§D):
 * - GET  /projects/{id}/insights — capability "view", NO job, deterministic
 *     -> {categories: [{id, covered_count, suggestable_count, status}],
 *         total_cases, total_covered, total_suggestable}
 * - POST /projects/{id}/insights/generate — capability "generate"
 *     {categories: [ids] (required, non-empty), requirement_ids?}
 *     -> 202 {job_id}; an illegal id -> 422 {code: "invalid_category"}
 *   The job follows the existing generation-job pattern exactly and is polled
 *   at GET /jobs/{id}; the cases it persists land as drafts in the review queue
 *   (technique "edge_case", edge_category set, >=1 requirement link each).
 */
import type { JobPoller } from './job-poller';
import type { TraceoHttp } from './http';
import type {
  InsightGenerateBody,
  InsightJobResult,
  InsightsSummary,
  Job,
  JobAccepted,
  TestCase,
} from './types';

/**
 * The job result calls the persisted-cases counter `generated` (the shared
 * generation-job shape), while the audit entry of the same run calls it
 * `created`. Normalised in ONE place so specs assert a single number instead
 * of spreading the tolerance across assertions.
 */
export function createdCount(result: InsightJobResult): number {
  return result.generated ?? result.created ?? 0;
}

/** What one insight run produced — the job counters plus the resulting queue. */
export interface InsightRunOutcome {
  result: InsightJobResult;
  /** Every test case of the project after the run (drafts included). */
  cases: TestCase[];
}

export class InsightRepository {
  constructor(
    private readonly http: TraceoHttp,
    private readonly jobs: JobPoller,
  ) {}

  /** The coverage map of the 9 canonical categories. Synchronous — no job. */
  async getInsights(projectId: string): Promise<InsightsSummary> {
    return this.http.get<InsightsSummary>(`/projects/${projectId}/insights`);
  }

  /** 202 flavour — returns {job_id} immediately. */
  async generate(projectId: string, body: InsightGenerateBody): Promise<JobAccepted> {
    return this.http.post<JobAccepted>(`/projects/${projectId}/insights/generate`, body);
  }

  /**
   * Start a run, poll its job through the single waiting point (§16), and
   * return BOTH the job counters and the resulting queue: a second run for the
   * same categories would be a different (deduplicated) population, so a spec
   * must be able to assert counters and cases against one and the same run.
   *
   * The job kind is 'insight' (jobs.submit("insight", …)) — its own budget in
   * KIND_TIMEOUTS_MS, mirroring the generate budget.
   */
  async generateAndWait(
    projectId: string,
    body: InsightGenerateBody,
  ): Promise<InsightRunOutcome> {
    const { job_id } = await this.generate(projectId, body);
    const job: Job = await this.jobs.waitFor(job_id, 'insight');
    const { test_cases } = await this.http.get<{ test_cases: TestCase[] }>(
      `/projects/${projectId}/test-cases`,
    );
    return { result: job.result as InsightJobResult, cases: test_cases };
  }
}
