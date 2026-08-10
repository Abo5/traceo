/**
 * Full permission matrix — API level, data-driven (@permission @regression).
 *
 * SOURCE OF TRUTH: backend/app/security.py — ROLES × PERMISSIONS (SRS §4.10).
 * The MATRIX table below is a 1:1 transcription of that dict; if security.py
 * changes, this table must change with it (that is the point: a drift fails
 * loudly here). Every (capability, role) pair becomes one test:
 *   - allowed  -> the representative endpoint answers 2xx (repositories throw
 *                 a typed ApiError on any non-2xx, so a clean resolve IS the 2xx);
 *   - denied   -> the server refuses with the uniform error code `forbidden`
 *                 (asserted on ApiError.code/status, never on message text).
 *
 * Probes are chosen to be repeatable across every allowed role (unique payloads;
 * approve is idempotent server-side — only `archived` cases 409). Shared state is
 * arranged once per worker over the API (§9) in the worker-scoped org; no
 * teardown by design — the org is isolated and disposable (§8).
 * The UI half of the permission story stays in permissions.spec.ts.
 */
import { test, expect } from '../fixtures';
import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { config } from '../config/resolve';
import { ROLES, type Role } from '../constants/roles';
import { sampleFile } from '../helpers/test-data';
import { uniqueEmail, uniqueSuffix } from '../helpers/unique';
import { projectFactory } from '../test-data/project.factory';

/** State arranged once per worker — everything a probe may need already exists. */
interface MatrixContext {
  projectId: string;
  requirementId: string;
  /** Draft case probes may edit/approve freely (approve is idempotent). */
  editableCaseId: string;
  /** Approved in beforeAll and never touched again — keeps trigger_run green. */
  approvedCaseId: string;
  environmentId: string;
}

type Probe = (client: ApiClient, ctx: MatrixContext) => Promise<unknown>;

/**
 * ROLES × PERMISSIONS — transcribed from backend/app/security.py `PERMISSIONS`.
 * `probe` hits ONE representative endpoint guarded by exactly that capability
 * (the require("<capability>") dependency in the named backend module).
 */
const MATRIX: Record<string, { allowed: readonly Role[]; probe: Probe }> = {
  // identity.py: POST /members/invite
  manage_members: {
    allowed: ['admin'],
    probe: (client) =>
      client.identity.invite({
        email: uniqueEmail('matrix-invite'),
        name: 'E2E Matrix Invite',
        role: 'viewer',
        password: 'E2e-pass-12345',
      }),
  },
  // projects.py: POST /projects
  manage_projects: {
    allowed: ['admin', 'qa_lead'],
    probe: (client) => client.projects.create(projectFactory()),
  },
  // projects.py: POST /projects/{id}/environments
  manage_environments: {
    allowed: ['admin', 'qa_lead'],
    probe: (client, ctx) =>
      client.projects.createEnvironment(ctx.projectId, {
        name: `matrix-env-${uniqueSuffix()}`,
        base_url: config.sutUrl,
      }),
  },
  // ingestion.py: POST /projects/{id}/documents (202 — the guard fires before the job)
  upload_documents: {
    allowed: ['admin', 'qa_lead', 'qa_engineer'],
    probe: (client, ctx) =>
      client.ingestion.uploadDocument(ctx.projectId, sampleFile('sample_requirements_en.md')),
  },
  // ingestion.py: POST /requirements (manual authoring — repeatable, unique body)
  edit_requirements: {
    allowed: ['admin', 'qa_lead', 'qa_engineer'],
    probe: (client, ctx) =>
      client.ingestion.createRequirement({
        project_id: ctx.projectId,
        description: `matrix requirement ${uniqueSuffix()}`,
      }),
  },
  // discovery.py: POST /projects/{id}/api-specs (synchronous — 201 with a diff)
  import_spec: {
    allowed: ['admin', 'qa_lead', 'qa_engineer'],
    probe: (client, ctx) =>
      client.discovery.importSpec(ctx.projectId, sampleFile('sample_openapi.yaml')),
  },
  // generation.py: POST /projects/{id}/generate (202 {job_id}; mock LLM, not awaited)
  generate: {
    allowed: ['admin', 'qa_lead', 'qa_engineer'],
    probe: (client, ctx) => client.generation.generate(ctx.projectId),
  },
  // review.py: PATCH /test-cases/{id}
  edit_test_case: {
    allowed: ['admin', 'qa_lead', 'qa_engineer'],
    probe: (client, ctx) =>
      client.review.update(ctx.editableCaseId, { title: `matrix edit ${uniqueSuffix()}` }),
  },
  // review.py: POST /test-cases/{id}/approve (idempotent — only `archived` 409s)
  approve_reject: {
    allowed: ['admin', 'qa_lead'],
    probe: (client, ctx) => client.review.approve(ctx.editableCaseId),
  },
  // execution.py: POST /projects/{id}/runs (202 — scoped to the untouched approved case)
  trigger_run: {
    allowed: ['admin', 'qa_lead', 'qa_engineer'],
    probe: (client, ctx) =>
      client.runs.create(ctx.projectId, {
        environment_id: ctx.environmentId,
        test_case_ids: [ctx.approvedCaseId],
      }),
  },
  // projects.py: GET /projects
  view: {
    allowed: ['admin', 'qa_lead', 'qa_engineer', 'viewer'],
    probe: (client) => client.projects.list(),
  },
  // reporting.py: GET /projects/{id}/exports/matrix.xlsx — no reporting repository
  // yet, so this one goes through the typed http layer; only the 2xx matters
  // (the binary body is returned unparsed).
  export: {
    allowed: ['admin', 'qa_lead', 'qa_engineer', 'viewer'],
    probe: (client, ctx) => client.http.get<string>(`/projects/${ctx.projectId}/exports/matrix.xlsx`),
  },
  // identity.py: GET /audit
  view_audit_log: {
    allowed: ['admin', 'qa_lead'],
    probe: (client) => client.identity.auditLog(1),
  },
};

test.describe('permission matrix @permission @regression', () => {
  let ctx: MatrixContext;

  // Arrange once per worker as qa_lead (manage_projects and everything below it
  // — backend/app/security.py). Manual authoring keeps this deterministic and
  // pipeline-free: probes exercise upload/import/generate themselves.
  test.beforeAll(async ({ api }) => {
    const lead = api.as('qa_lead');
    const project = await lead.projects.create(projectFactory());
    const requirement = await lead.ingestion.createRequirement({
      project_id: project.id,
      description: `matrix seed requirement ${uniqueSuffix()}`,
    });
    const editable = await lead.review.createManual(project.id, {
      title: `matrix editable case ${uniqueSuffix()}`,
      requirement_ids: [requirement.id],
    });
    const runnable = await lead.review.createManual(project.id, {
      title: `matrix runnable case ${uniqueSuffix()}`,
      requirement_ids: [requirement.id],
    });
    await lead.review.approve(runnable.id); // trigger_run needs >=1 approved case
    const environment = await lead.projects.createEnvironment(project.id, {
      name: `matrix-base-env-${uniqueSuffix()}`,
      base_url: config.sutUrl,
    });
    ctx = {
      projectId: project.id,
      requirementId: requirement.id,
      editableCaseId: editable.id,
      approvedCaseId: runnable.id,
      environmentId: environment.id,
    };
  });

  for (const [capability, { allowed, probe }] of Object.entries(MATRIX)) {
    for (const role of ROLES) {
      if (allowed.includes(role)) {
        test(`${capability}: ${role} is allowed (2xx)`, async ({ api }) => {
          // repositories throw ApiError on any non-2xx — resolving IS the 2xx
          await probe(api.as(role), ctx);
        });
      } else {
        test(`${capability}: ${role} is forbidden`, async ({ api }) => {
          const err = await probe(api.as(role), ctx).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(ApiError);
          expect((err as ApiError).code).toBe('forbidden');
          expect((err as ApiError).status).toBe(403);
        });
      }
    }
  }
});
