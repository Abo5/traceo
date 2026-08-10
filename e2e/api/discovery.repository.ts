/**
 * Discovery repository — backend/app/modules/discovery.py (deterministic conversion,
 * no LLM; the optional AI enrichment layer is annotation-only and gated).
 *
 * Verified shapes:
 * - POST /projects/{id}/api-specs — multipart 'file' OR JSON {url}; ONE endpoint
 *   for every supported document. The format detector is deterministic:
 *     openapi3   — `openapi: 3.x`
 *     swagger2   — `swagger: "2.0"`
 *     postman2   — info.schema contains "getpostman.com/json/collection/v2"
 *     har        — top-level "log" object with "entries"
 *     insomnia4  — `"_type": "export"` with "resources"
 *   Anything else stays 422 {code: "invalid_spec"} with an `errors` list that
 *   names the formats actually supported.
 *   Parsed SYNCHRONOUSLY -> 201 {spec_id, version, endpoints_count, warnings, diff,
 *   format, added, updated, removed, total, enriched, enrichment_discarded}
 * - GET  /projects/{id}/endpoints -> Endpoint[] (+ FR-024 coverage fields
 *   + nullable ai_description / ai_group / ai_criticality)
 * - PATCH /endpoints/{eid} {excluded: bool}
 */
import type { MultipartFile, TraceoHttp } from './http';
import type { Endpoint, ImportSpecResult } from './types';

export class DiscoveryRepository {
  constructor(private readonly http: TraceoHttp) {}

  /**
   * Import an API document by file. Synchronous on the server — no job.
   *
   * The same call takes an OpenAPI/Swagger spec AND a Postman collection, a HAR
   * capture or an Insomnia export: the server detects the format, so the caller
   * only changes the file. Read the detected format off `result.format`.
   */
  async importSpec(projectId: string, file: MultipartFile): Promise<ImportSpecResult> {
    return this.http.postMultipart<ImportSpecResult>(`/projects/${projectId}/api-specs`, file);
  }

  /** URL flavour (SSRF-guarded server side) — same detector, same response. */
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

// --- read helpers (no assertions — specs own those) -----------------------------

/** "METHOD /path" — the identity an endpoint, a step and a collection request share. */
export function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** The inventory as a comparable set of "METHOD /path" keys. */
export function inventoryKeys(endpoints: Endpoint[]): string[] {
  return endpoints.map((e) => endpointKey(e.method, e.path));
}

/**
 * Names of the parameters recorded on an endpoint at a given location.
 *
 * The API normalises OpenAPI's `in` onto `location` (path|query|header|cookie|
 * formData) before storing, so `location` — not `in` — is the field that exists
 * on the wire. Reading `in` here silently returned [] for every endpoint and
 * made the query-parameter assertions vacuous.
 */
export function paramNamesAt(endpoint: Endpoint, location: string): string[] {
  return endpoint.parameters
    .filter((p) => String(p.location) === location)
    .map((p) => String(p.name ?? ''))
    .filter(Boolean);
}

/** Names of the query parameters recorded on an endpoint (`location: "query"`). */
export function queryParamNames(endpoint: Endpoint): string[] {
  return paramNamesAt(endpoint, 'query');
}

/**
 * Top-level property names of an endpoint's inferred request body schema.
 * Empty for endpoints without a JSON body, and for non-JSON bodies (which
 * record a media type and field names, not a schema).
 */
export function requestBodyFields(endpoint: Endpoint): string[] {
  const schema = endpoint.request_schema;
  if (!schema || typeof schema !== 'object') return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.keys(properties as Record<string, unknown>);
}

/** Endpoints carrying at least one enrichment annotation. */
export function enrichedEndpoints(endpoints: Endpoint[]): Endpoint[] {
  return endpoints.filter(
    (e) => e.ai_description != null || e.ai_group != null || e.ai_criticality != null,
  );
}
