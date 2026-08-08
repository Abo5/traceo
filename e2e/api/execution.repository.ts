/**
 * Runs repository — backend/app/modules/execution.py.
 *
 * Verified shapes:
 * - POST /projects/{id}/runs {environment_id, test_case_ids?} -> 202 {job_id, run_id}
 *   (409 no_approved_cases when nothing approved matches); job kind 'execute'
 * - GET  /runs/{id} -> run payload (+display_id)
 * - GET  /runs/{id}/results?outcome= -> {run_id, results: [...]}
 * - GET  /projects/{id}/runs -> {runs: [...]}
 * - POST /runs/{id}/cancel -> {run_id, state, cancel_requested}
 */
import type { JobPoller } from './job-poller';
import type { TraceoHttp } from './http';
import type { ResultOutcome } from '../constants/states';
import type { Run, RunAccepted, RunResult } from './types';

export class RunsRepository {
  constructor(
    private readonly http: TraceoHttp,
    private readonly jobs: JobPoller,
  ) {}

  /** 202 flavour — returns {job_id, run_id} immediately. */
  async create(
    projectId: string,
    body: { environment_id: string; test_case_ids?: string[] },
  ): Promise<RunAccepted> {
    return this.http.post<RunAccepted>(`/projects/${projectId}/runs`, body);
  }

  /** Launch a run, poll the execute job, return the final run record. */
  async createAndWait(
    projectId: string,
    body: { environment_id: string; test_case_ids?: string[] },
  ): Promise<Run> {
    const accepted = await this.create(projectId, body);
    await this.jobs.waitFor(accepted.job_id, 'execute');
    return this.get(accepted.run_id);
  }

  async get(runId: string): Promise<Run> {
    return this.http.get<Run>(`/runs/${runId}`);
  }

  async results(runId: string, outcome?: ResultOutcome): Promise<RunResult[]> {
    const { results } = await this.http.get<{ run_id: string; results: RunResult[] }>(
      `/runs/${runId}/results`,
      { outcome },
    );
    return results;
  }

  async list(projectId: string): Promise<Run[]> {
    const { runs } = await this.http.get<{ runs: Run[] }>(`/projects/${projectId}/runs`);
    return runs;
  }

  async cancel(runId: string): Promise<{ run_id: string; state: string; cancel_requested: boolean }> {
    return this.http.post(`/runs/${runId}/cancel`);
  }
}
