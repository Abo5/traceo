/**
 * Review repository — backend/app/modules/review.py.
 *
 * Verified shapes:
 * - GET  /projects/{id}/test-cases?state=&requirement_id=&type=&q= -> {test_cases: [...]}
 * - GET  /test-cases/{id} -> case detail incl. steps + requirements alias
 * - POST /projects/{id}/test-cases {title, requirement_ids, ...} -> 201 case detail
 *   (empty requirement_ids -> 422 missing_requirements)
 * - POST /test-cases/{id}/approve -> case payload
 * - POST /test-cases/{id}/reject {reason_code: incorrect|shallow|duplicate|other, reason_text?}
 * - POST /test-cases/bulk {ids, action: approve|reject, reason_code?, reason_text?}
 *   -> {action, processed, errors}
 */
import type { TraceoHttp } from './http';
import type {
  BulkAction,
  BulkResult,
  NewTestCase,
  RejectReasonCode,
  RequirementLink,
  TestCase,
} from './types';

export class ReviewRepository {
  constructor(private readonly http: TraceoHttp) {}

  async list(
    projectId: string,
    filters: { state?: string; requirement_id?: string; type?: string; q?: string } = {},
  ): Promise<TestCase[]> {
    const { test_cases } = await this.http.get<{ test_cases: TestCase[] }>(
      `/projects/${projectId}/test-cases`,
      filters,
    );
    return test_cases;
  }

  async get(caseId: string): Promise<TestCase> {
    return this.http.get<TestCase>(`/test-cases/${caseId}`);
  }

  /** The contract enforces non-empty requirement_ids — 422 missing_requirements otherwise. */
  async createManual(projectId: string, body: NewTestCase): Promise<TestCase> {
    return this.http.post<TestCase>(`/projects/${projectId}/test-cases`, body);
  }

  async update(caseId: string, body: Partial<NewTestCase>): Promise<TestCase> {
    return this.http.patch<TestCase>(`/test-cases/${caseId}`, body);
  }

  async approve(caseId: string): Promise<TestCase> {
    return this.http.post<TestCase>(`/test-cases/${caseId}/approve`);
  }

  async reject(caseId: string, reasonCode: RejectReasonCode, reasonText = ''): Promise<TestCase> {
    return this.http.post<TestCase>(`/test-cases/${caseId}/reject`, {
      reason_code: reasonCode,
      reason_text: reasonText,
    });
  }

  async bulk(
    action: BulkAction,
    ids: string[],
    reasonCode?: RejectReasonCode,
  ): Promise<BulkResult> {
    return this.http.post<BulkResult>('/test-cases/bulk', {
      ids,
      action,
      reason_code: reasonCode,
    });
  }

  // --- traceability links (FR-TRC-05) ------------------------------------------

  async addLink(
    caseId: string,
    requirementId: string,
  ): Promise<{ test_case_id: string; links: RequirementLink[] }> {
    return this.http.post(`/test-cases/${caseId}/links`, { requirement_id: requirementId });
  }

  async removeLink(
    caseId: string,
    requirementId: string,
  ): Promise<{ test_case_id: string; links: RequirementLink[] }> {
    return this.http.delete(`/test-cases/${caseId}/links/${requirementId}`);
  }
}
