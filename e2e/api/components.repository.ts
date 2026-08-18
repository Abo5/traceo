/**
 * Components repository — S2 of docs/SECURITY_TESTING_PLAN.md.
 * Python: backend/app/modules/components.py; Go: the parity routes.
 *
 * The inventory is what turns a CVE feed from news about other people's
 * software into something actionable (plan §2), so the parsers are pure,
 * offline and deliberately literal: a range or an unpinned line is RECORDED
 * with `version: null` and counted as `unpinned` — never guessed into a number.
 *
 * Verified shapes (fixed contract S2.2):
 * - POST   /projects/{id}/components — capability "import_spec", multipart 'file'
 *     -> 202 {job_id}; job result {format, added, updated, unpinned, total}
 *     A file matching no known format -> 422 {code: "unsupported_component_format"}
 *     whose `errors` list NAMES the supported formats (the actionable refusal,
 *     mirroring the spec importer's `invalid_spec`).
 * - GET    /projects/{id}/components — capability "view" -> {components: [...]}
 * - DELETE /components/{id} — capability "import_spec"
 */
import type { JobPoller } from './job-poller';
import type { MultipartFile, TraceoHttp } from './http';
import type { Component, ComponentImportResult, Job, JobAccepted } from './types';

export class ComponentsRepository {
  constructor(
    private readonly http: TraceoHttp,
    private readonly jobs: JobPoller,
  ) {}

  /** 202 flavour — returns {job_id} immediately (the 422 refusal happens here). */
  async importManifest(projectId: string, file: MultipartFile): Promise<JobAccepted> {
    return this.http.postMultipart<JobAccepted>(`/projects/${projectId}/components`, file);
  }

  /** Upload, poll the parse job, and return its counters. */
  async importAndWait(projectId: string, file: MultipartFile): Promise<ComponentImportResult> {
    const { job_id } = await this.importManifest(projectId, file);
    const job: Job = await this.jobs.waitFor(job_id, 'components');
    return job.result as ComponentImportResult;
  }

  async list(projectId: string): Promise<Component[]> {
    const { components } = await this.http.get<{ components: Component[] }>(
      `/projects/${projectId}/components`,
    );
    return components;
  }

  async remove(componentId: string): Promise<unknown> {
    return this.http.delete(`/components/${componentId}`);
  }
}

// --- read helpers (no assertions — specs own those) -----------------------------

/** "name@version" identity of a component; an unpinned version reads as `@null`. */
export function componentKey(name: string, version: string | null | undefined): string {
  return `${name}@${version ?? 'null'}`;
}

/** The inventory as a comparable set of "name@version" keys. */
export function componentKeys(components: Component[]): string[] {
  return components.map((c) => componentKey(c.name, c.version));
}

/** Components recorded WITHOUT a version — the honest half of the report (§2). */
export function unpinnedComponents(components: Component[]): Component[] {
  return components.filter((c) => c.version === null);
}
