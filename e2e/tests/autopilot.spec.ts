/**
 * Autopilot chain (automation:"auto") — the ONLY spec that leaves the server's
 * automation default on. It arranges nothing but the raw inputs:
 *
 *   create project (automation "auto") → upload the requirements .md
 *   → parse job → auto.requirements.confirm_all → import OpenAPI spec
 *   → auto.generate → draft cases — WITHOUT ever calling confirm_all or generate.
 *
 * There is no language step in the chain: Traceo is English-only, so the
 * autopilot goes straight from a successful parse to confirming every extracted
 * requirement and triggering generation.
 *
 * Approval and runs stay manual (BO-07) — the autopilot stops at drafts, so the
 * review page is where the chain must land. Every wait funnels through
 * JobPoller / expect.poll (§16 — no sleeps). Everything else in the suite pins
 * automation:"manual" via projectFactory (see test-data/project.factory.ts).
 */
import { test, expect } from '../fixtures';
import { sampleFile } from '../helpers/test-data';
import { projectFactory } from '../test-data/project.factory';
import { ReviewPage } from '../pages/review.page';

/** Dev-server first navigation compiles the route on demand (§16). */
const FIRST_VISIT_TIMEOUT_MS = 20_000;
/** Budget for the whole server-side chain: parse already waited; confirm + generate remain. */
const AUTOPILOT_POLL_TIMEOUT_MS = 180_000;

/** Audit actions the contract prescribes for the chain — prefixed "auto.". */
const AUTOPILOT_ACTIONS = ['auto.requirements.confirm_all', 'auto.generate'] as const;

test.describe('autopilot @critical @regression', () => {
  test('upload + import alone yield reviewable drafts and auto.* audit entries', async ({
    api,
    asQaLead,
  }) => {
    // parse (≤90s waited inline) + the polled confirm/generate chain (≤180s) + UI.
    test.setTimeout(300_000);
    const lead = api.as('qa_lead');

    // Override the factory's deterministic "manual" default on purpose.
    const project = await lead.projects.create(projectFactory({ automation: 'auto' }));
    expect(project.automation).toBe('auto');

    await test.step('upload the requirements document (no confirm_all)', async () => {
      await lead.ingestion.uploadAndWait(project.id, sampleFile('sample_requirements_en.md'));
    });

    await test.step('import the OpenAPI sample (no generate)', async () => {
      const imported = await lead.discovery.importSpec(project.id, sampleFile('sample_openapi.yaml'));
      expect(imported.endpoints_count).toBeGreaterThan(0);
    });

    await test.step('draft cases appear without any manual trigger', async () => {
      await expect
        .poll(async () => (await lead.review.list(project.id, { state: 'draft' })).length, {
          message: 'autopilot never produced draft test cases',
          timeout: AUTOPILOT_POLL_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);
    });

    await test.step('every auto step left an "auto."-prefixed audit entry', async () => {
      const { items } = await lead.identity.auditLog(200);
      const autoActions = items
        .filter((entry) => entry.action.startsWith('auto.'))
        .map((entry) => entry.action);
      for (const action of AUTOPILOT_ACTIONS) {
        expect(autoActions, `audit log is missing ${action}`).toContain(action);
      }
    });

    // Human gate (BO-07): the chain stops at drafts awaiting review in the UI.
    await test.step('the review page lists the auto-generated drafts', async () => {
      const review = new ReviewPage(asQaLead);
      await review.goto(project.id);
      await expect(review.stateOfFirst).toHaveAttribute('data-state', 'draft', {
        timeout: FIRST_VISIT_TIMEOUT_MS,
      });
    });
  });
});
