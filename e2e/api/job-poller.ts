/**
 * JobPoller — the single waiting point of the framework (§11, §16). Any
 * repository that receives `202 {job_id}` funnels through here; never
 * `waitForTimeout` in specs.
 *
 * Per-kind timeouts (parse is quicker than generate); failure messages always
 * carry the job id and the last observed state — the top diagnostic trace in
 * this app.
 */
import type { JobKind } from '../constants/states';
import type { Job } from './types';
import type { TraceoHttp } from './http';

const POLL_INTERVAL_MS = 500;

/** Explicit per-kind budgets (§16) — ingest/parse shorter than generate/execute. */
const KIND_TIMEOUTS_MS: Record<JobKind, number> = {
  ingest: 90_000,
  generate: 120_000,
  execute: 180_000,
  report: 60_000,
  // deterministic builders (no model call) but the same per-endpoint fan-out
  // as generate — budgeted alike rather than optimistically.
  insight: 120_000,
};

const DEFAULT_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JobPoller {
  constructor(private readonly http: TraceoHttp) {}

  /**
   * Poll GET /v1/jobs/{id} until `completed`. Throws with the job id and the
   * last observed state on `failed` or on timeout. Returns the completed Job
   * (its `result` carries the job outcome payload).
   */
  async waitFor(jobId: string, kind?: JobKind): Promise<Job> {
    const started = Date.now();
    let last: Job | undefined;
    let timeout = kind ? KIND_TIMEOUTS_MS[kind] : DEFAULT_TIMEOUT_MS;

    while (Date.now() - started < timeout) {
      last = await this.http.get<Job>(`/jobs/${jobId}`);
      // once the server reports the kind, adopt its per-kind budget
      if (!kind && last.kind && KIND_TIMEOUTS_MS[last.kind]) {
        timeout = KIND_TIMEOUTS_MS[last.kind];
      }
      if (last.status === 'completed') return last;
      if (last.status === 'failed') {
        throw new Error(
          `Job ${jobId} (${last.kind}) failed: ${last.error ?? 'no error detail'} ` +
            `(last state: ${last.status}, progress: ${last.progress})`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `Job ${jobId}${last ? ` (${last.kind})` : ''} timed out after ${timeout}ms ` +
        `(last state: ${last?.status ?? 'never observed'}` +
        `${last?.message ? `, message: ${last.message}` : ''})`,
    );
  }
}
