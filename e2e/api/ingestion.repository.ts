/**
 * Ingestion repository — backend/app/modules/ingestion.py.
 *
 * Verified shapes:
 * - POST /projects/{id}/documents (multipart 'file': pdf/docx/md/txt)
 *   -> 202 {job_id, document_id}; job kind 'ingest'
 * - POST /projects/{id}/requirements/confirm_all -> {confirmed: <count>}
 * - GET  /projects/{id}/requirements?state=&type=&priority=&q= -> Requirement[]
 */
import type { JobPoller } from './job-poller';
import type { MultipartFile, TraceoHttp } from './http';
import type { Job, Requirement, SourceDocument, UploadAccepted } from './types';

export class IngestionRepository {
  constructor(
    private readonly http: TraceoHttp,
    private readonly jobs: JobPoller,
  ) {}

  /** 202 flavour — returns immediately with {job_id, document_id}. */
  async uploadDocument(projectId: string, file: MultipartFile): Promise<UploadAccepted> {
    return this.http.postMultipart<UploadAccepted>(`/projects/${projectId}/documents`, file);
  }

  /** Upload then poll the ingest job to completion. */
  async uploadAndWait(projectId: string, file: MultipartFile): Promise<{ documentId: string; job: Job }> {
    const accepted = await this.uploadDocument(projectId, file);
    const job = await this.jobs.waitFor(accepted.job_id, 'ingest');
    return { documentId: accepted.document_id, job };
  }

  /** Full setup seam used by fixtures: upload -> poll -> confirm_all. */
  async uploadAndConfirm(
    projectId: string,
    file: MultipartFile,
  ): Promise<{ documentId: string; confirmed: number }> {
    const { documentId } = await this.uploadAndWait(projectId, file);
    const { confirmed } = await this.confirmAll(projectId);
    return { documentId, confirmed };
  }

  async confirmAll(projectId: string): Promise<{ confirmed: number }> {
    return this.http.post<{ confirmed: number }>(`/projects/${projectId}/requirements/confirm_all`);
  }

  async listDocuments(projectId: string): Promise<SourceDocument[]> {
    return this.http.get<SourceDocument[]>(`/projects/${projectId}/documents`);
  }

  async listRequirements(
    projectId: string,
    filters: { state?: string; type?: string; priority?: string; q?: string } = {},
  ): Promise<Requirement[]> {
    return this.http.get<Requirement[]>(`/projects/${projectId}/requirements`, filters);
  }

  async updateRequirement(
    requirementId: string,
    body: Partial<
      Pick<Requirement, 'description' | 'external_id' | 'acceptance_criteria' | 'type' | 'priority'>
    > & { state?: 'confirmed' },
  ): Promise<Requirement> {
    return this.http.patch<Requirement>(`/requirements/${requirementId}`, body);
  }

  /** Manual authoring — lands directly in state 'confirmed' (human-authored). */
  async createRequirement(body: {
    project_id: string;
    description: string;
    external_id?: string;
    acceptance_criteria?: string[];
    type?: Requirement['type'];
    priority?: string;
  }): Promise<Requirement> {
    return this.http.post<Requirement>('/requirements', body);
  }
}
