/**
 * Projects repository — backend/app/modules/projects.py.
 *
 * Verified shapes:
 * - POST /projects {name, automation?} -> 201 project payload
 *   (manage_projects: admin|qa_lead; automation defaults to "auto" — autopilot
 *   contract. There is no project language: Traceo is English-only.)
 * - POST /projects/{id}/environments {name, base_url, auth_type?, auth_config?, variables?, tls_strict?}
 *   -> 201 env payload; auth_config is write-only, reads expose auth_config_masked.
 * - GET  /projects/{id}/environments -> Environment[] (capability "view", so the
 *   default qa_engineer client can read them). This is also how an environment
 *   DERIVED by an api-specs import is read back: the import echoes only
 *   {id, name, base_url} on `environment_created`, and the full row — variables,
 *   auth_type, tls_strict — is fetched here. No new route exists for it.
 */
import type { TraceoHttp } from './http';
import type { Environment, NewEnvironment, NewProject, Project } from './types';

export class ProjectsRepository {
  constructor(private readonly http: TraceoHttp) {}

  async create(body: NewProject): Promise<Project> {
    return this.http.post<Project>('/projects', body);
  }

  async list(status?: 'active' | 'archived'): Promise<Project[]> {
    return this.http.get<Project[]>('/projects', { status });
  }

  async get(projectId: string): Promise<Project> {
    return this.http.get<Project>(`/projects/${projectId}`);
  }

  async update(
    projectId: string,
    body: Partial<{
      name: string;
      automation: 'auto' | 'manual';
      status: 'active' | 'archived';
    }>,
  ): Promise<Project> {
    return this.http.patch<Project>(`/projects/${projectId}`, body);
  }

  async remove(projectId: string): Promise<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/projects/${projectId}`);
  }

  /** FR-PRJ-07 dashboard — asserted fields only; the payload carries more. */
  async dashboard(projectId: string): Promise<{
    requirement_count: number;
    confirmed_count: number;
    test_case_counts: Record<string, number>;
    coverage_pct: number;
    latest_run: Record<string, unknown> | null;
  }> {
    return this.http.get(`/projects/${projectId}/dashboard`);
  }

  // --- environments (FR-PRJ-04/05) --------------------------------------------

  async createEnvironment(projectId: string, body: NewEnvironment): Promise<Environment> {
    return this.http.post<Environment>(`/projects/${projectId}/environments`, body);
  }

  async listEnvironments(projectId: string): Promise<Environment[]> {
    return this.http.get<Environment[]>(`/projects/${projectId}/environments`);
  }

  async checkEnvironment(
    projectId: string,
    envId: string,
  ): Promise<{ reachable: boolean; status_code?: number; auth_applied: boolean; error?: string }> {
    return this.http.post(`/projects/${projectId}/environments/${envId}/check`);
  }
}

// --- read helpers (no assertions — specs own those) -----------------------------

/** The listed environment with this id, or undefined. */
export function environmentById(
  environments: Environment[],
  id: string,
): Environment | undefined {
  return environments.find((e) => e.id === id);
}

/** Environment variables as a flat string map (values are stored as JSON). */
export function environmentVariables(environment: Environment): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment.variables ?? {})) {
    out[key] = value == null ? '' : String(value);
  }
  return out;
}
