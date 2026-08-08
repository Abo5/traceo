/**
 * Generation repository — backend/app/modules/generation.py.
 *
 * Verified shapes:
 * - POST /projects/{id}/generate {requirement_ids?, depth: smoke|standard|exhaustive}
 *   -> 202 {job_id}; job kind 'generate';
 *   job result {generated, discarded, unmappable: [{requirement_id, reason}], duplicates}
 * - Generated cases land as drafts, listed via GET /projects/{id}/test-cases
 *   -> {test_cases: [...]} (review.py).
 */
import type { JobPoller } from './job-poller';
import type { TraceoHttp } from './http';
import type { GenerateBody, GenerationJobResult, Job, JobAccepted, TestCase } from './types';

export class GenerationRepository {
  constructor(
    private readonly http: TraceoHttp,
    private readonly jobs: JobPoller,
  ) {}

  /** 202 flavour — returns {job_id} immediately. */
  async generate(projectId: string, body: GenerateBody = {}): Promise<JobAccepted> {
    return this.http.post<JobAccepted>(`/projects/${projectId}/generate`, {
      depth: 'standard',
      ...body,
    });
  }

  /** Start generation, poll the job, return the project's test cases (drafts included). */
  async generateAndWait(projectId: string, body: GenerateBody = {}): Promise<TestCase[]> {
    const { job_id } = await this.generate(projectId, body);
    await this.jobs.waitFor(job_id, 'generate');
    const { test_cases } = await this.http.get<{ test_cases: TestCase[] }>(
      `/projects/${projectId}/test-cases`,
    );
    return test_cases;
  }

  /** Same as generateAndWait but surfaces the job's own result counters. */
  async generateAndWaitForResult(
    projectId: string,
    body: GenerateBody = {},
  ): Promise<GenerationJobResult> {
    const { job_id } = await this.generate(projectId, body);
    const job: Job = await this.jobs.waitFor(job_id, 'generate');
    return job.result as GenerationJobResult;
  }
}
