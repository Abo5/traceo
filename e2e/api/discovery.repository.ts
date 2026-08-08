/**
 * Discovery repository — backend/app/modules/discovery.py (deterministic, no LLM).
 *
 * Verified shapes:
 * - POST /projects/{id}/api-specs — multipart 'file' (json/yaml) OR JSON {url};
 *   parsed SYNCHRONOUSLY -> 201 {spec_id, version, endpoints_count, warnings, diff}
 * - GET  /projects/{id}/endpoints -> Endpoint[] (+ FR-024 coverage fields)
 * - PATCH /endpoints/{eid} {excluded: bool}
 */
import type { MultipartFile, TraceoHttp } from './http';
import type { Endpoint, ImportSpecResult } from './types';

export class DiscoveryRepository {
  constructor(private readonly http: TraceoHttp) {}

  /** Import an OpenAPI/Swagger spec file. Synchronous on the server — no job. */
  async importSpec(projectId: string, file: MultipartFile): Promise<ImportSpecResult> {
    return this.http.postMultipart<ImportSpecResult>(`/projects/${projectId}/api-specs`, file);
  }

  /** URL flavour (SSRF-guarded server side). */
  async importSpecFromUrl(projectId: string, url: string): Promise<ImportSpecResult> {
    return this.http.post<ImportSpecResult>(`/projects/${projectId}/api-specs`, { url });
  }

  async listEndpoints(projectId: string): Promise<Endpoint[]> {
    return this.http.get<Endpoint[]>(`/projects/${projectId}/endpoints`);
  }

  /** FR-DSC-05 — body must be exactly {excluded: true|false}. */
  async setExcluded(endpointId: string, excluded: boolean): Promise<Endpoint> {
    return this.http.patch<Endpoint>(`/endpoints/${endpointId}`, { excluded });
  }
}
