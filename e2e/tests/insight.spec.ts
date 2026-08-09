/**
 * QA Insight Agent (وكيل الرؤى) — the sixth engine, end to end (@critical
 * @regression).
 *
 * What makes this engine different from the LLM generator is exactly what this
 * spec is built to prove:
 *   1. it is DETERMINISTIC and offline — no model call, so the same inventory
 *      always yields the same coverage map (statuses are a pure function of the
 *      two counters, asserted as such);
 *   2. it is GROUNDED — every case it persists passes the same grounding gate
 *      (BO-07: zero fabricated identifiers). The adversarial assertion below is
 *      the product's core promise turned into an oracle: every step of every
 *      generated case must name a method+path that exists in the project's own
 *      discovered endpoint inventory.
 *
 * Arrangement is API-side (§9): the `project` fixture pins automation "manual"
 * (test-data/project.factory.ts), so nothing auto-confirms or auto-generates in
 * the background and the counters observed here are the ones this spec caused.
 * The requirements document + OpenAPI sample are the same reference seeds the
 * pipeline fixtures use, so the inventory is real, not synthetic.
 *
 * State is asserted through data-state and the literal backend vocabularies
 * (constants/states.ts), never through the bilingual UI copy (§5, §6).
 */
import type { ApiClient } from '../api/client';
import { createdCount } from '../api/insight.repository';
import type { Endpoint, InsightsSummary, TestCase } from '../api/types';
import { test, expect } from '../fixtures';
import {
  EDGE_CATEGORIES,
  INSIGHT_STATUSES,
  TEST_TECHNIQUES,
  type EdgeCategory,
  type TestTechnique,
} from '../constants/states';
import { expectApiError } from '../helpers/expect-api-error';
import { sampleFile } from '../helpers/test-data';
import { InsightsPage } from '../pages/insights.page';
import { ReviewPage } from '../pages/review.page';

/** Ingest job + spec import + a deterministic builder run, plus UI on top. */
const ENGINE_TEST_TIMEOUT_MS = 240_000;
/** Dev-server first navigation compiles the route on demand (§16). */
const FIRST_VISIT_TIMEOUT_MS = 20_000;

/**
 * Give the engine something to ground itself in: confirmed requirements (every
 * generated case must link to >=1) and a discovered endpoint inventory (every
 * builder derives its values from it). Nothing here is insight-specific — it is
 * the same arrangement the generation pipeline uses.
 */
async function groundProject(api: ApiClient, projectId: string): Promise<void> {
  await api.ingestion.uploadAndConfirm(projectId, sampleFile('sample_requirements_ar.md'));
  const imported = await api.discovery.importSpec(projectId, sampleFile('sample_openapi.yaml'));
  expect(imported.endpoints_count, 'the OpenAPI sample produced no endpoints').toBeGreaterThan(0);
}

/** Categories the engine says it can build for right now (status "gap"). */
function gapCategories(summary: InsightsSummary): EdgeCategory[] {
  return summary.categories.filter((c) => c.status === 'gap').map((c) => c.id);
}

/** "METHOD /path" key of an endpoint — the identity a generated step must match. */
function endpointKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** Only INCLUDED endpoints ground a builder — excluded ones are out of scope (§D). */
function includedInventory(endpoints: Endpoint[]): string[] {
  return endpoints.filter((e) => !e.excluded).map((e) => endpointKey(e.method, e.path));
}

test.describe('insight engine @critical @regression', () => {
  test('the coverage map reports the 9 canonical categories with statuses derived from their counters', async ({
    api,
    project,
  }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    await groundProject(api, project.id);

    const summary = await api.insights.getInsights(project.id);

    // The taxonomy is FIXED — the same 9 ids in both backends and the UI.
    expect(summary.categories.map((c) => c.id).sort()).toEqual([...EDGE_CATEGORIES].sort());

    for (const category of summary.categories) {
      expect(INSIGHT_STATUSES, `unknown status for ${category.id}`).toContain(category.status);
      expect(category.covered_count).toBeGreaterThanOrEqual(0);
      expect(category.suggestable_count).toBeGreaterThanOrEqual(0);

      // status is a pure function of the counters (contract §C) — a category
      // with nothing to build (e.g. timing_dst with no date-time field
      // anywhere) is n_a, never a "gap" the user could act on.
      const derived =
        category.covered_count > 0 ? 'covered' : category.suggestable_count > 0 ? 'gap' : 'n_a';
      expect(category.status, `status of ${category.id} contradicts its counters`).toBe(derived);
    }

    // A project with a fresh inventory and no insight cases yet: nothing is
    // covered, and at least one category must be actionable — otherwise the
    // dry-run builders found nothing at all and the engine is inert.
    expect(summary.categories.every((c) => c.covered_count === 0)).toBe(true);
    expect(gapCategories(summary).length, 'no category is actionable on a fresh inventory').toBeGreaterThan(0);

    for (const total of [summary.total_cases, summary.total_covered, summary.total_suggestable]) {
      expect(Number.isInteger(total)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(0);
    }
    expect(summary.total_suggestable).toBeGreaterThan(0);
  });

  test('generating gap categories yields grounded draft edge cases — no fabricated endpoint survives', async ({
    api,
    project,
  }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    await groundProject(api, project.id);

    const summary = await api.insights.getInsights(project.id);
    // 2–3 categories: enough to exercise several builders in one deterministic run.
    const requested = gapCategories(summary).slice(0, 3);
    expect(requested.length, 'the engine offered no gap category to generate for').toBeGreaterThan(0);

    const { result, cases } = await api.insights.generateAndWait(project.id, {
      categories: requested,
    });

    await test.step('the run reports what it persisted and what the gate discarded', async () => {
      expect(createdCount(result), 'the run persisted nothing').toBeGreaterThan(0);
      expect(result.discarded).toBeGreaterThanOrEqual(0);
    });

    // Vocabulary guard: `edge_case` joined an existing closed list — a value
    // outside it means the backends and constants/states.ts have drifted.
    for (const testCase of cases) {
      expect(TEST_TECHNIQUES, `unknown technique on case ${testCase.id}`).toContain(
        testCase.technique as TestTechnique,
      );
    }

    const edgeCases = cases.filter((c) => c.technique === 'edge_case');
    expect(edgeCases.length, 'no case carries technique "edge_case"').toBe(createdCount(result));

    await test.step('every generated case is a draft, categorised and traceable', async () => {
      for (const testCase of edgeCases) {
        expect(testCase).toBeInState('draft'); // the human gate stays closed (BO-07)
        expect(
          requested,
          `case ${testCase.id} carries edge_category ${testCase.edge_category}, which was not requested`,
        ).toContain(testCase.edge_category as EdgeCategory);
        expect(
          testCase.links.length,
          `case ${testCase.id} links to no requirement (the hard contract)`,
        ).toBeGreaterThan(0);
      }
    });

    // --- ADVERSARIAL GROUNDING ASSERTION (BO-07, the product's core promise) ---
    // The oracle is the project's OWN discovered inventory. Steps are matched
    // verbatim: no normalising of paths, no stripping of templated segments —
    // any such leniency would let an invented path pass as "close enough".
    await test.step('every step of every generated case exists in the endpoint inventory', async () => {
      const endpoints = await api.discovery.listEndpoints(project.id);
      const inventory = includedInventory(endpoints);
      const endpointIds = endpoints.map((e) => e.id);
      expect(inventory.length, 'empty inventory — the oracle would be vacuous').toBeGreaterThan(0);

      // Control: prove the oracle CAN fail. If a fabricated pair matched, every
      // assertion below would be meaningless.
      expect(inventory).not.toContain(endpointKey('POST', '/__traceo_fabricated__/{id}'));
      expect(inventory).not.toContain(endpointKey('GET', '/auth/login')); // right path, wrong method

      let stepsChecked = 0;
      for (const listed of edgeCases) {
        const detail: TestCase = await api.review.get(listed.id);
        const steps = detail.steps ?? [];
        // A case with no steps would pass the loop below vacuously.
        expect(steps.length, `insight case ${detail.id} has no step to ground`).toBeGreaterThan(0);

        for (const step of steps) {
          const key = endpointKey(step.method ?? '', step.path ?? '');
          expect(
            inventory,
            `case ${detail.id} step #${step.order} calls "${key}" — absent from the ` +
              `project's endpoint inventory (fabricated identifier, BO-07)`,
          ).toContain(key);
          if (step.endpoint_id !== null && step.endpoint_id !== undefined) {
            expect(
              endpointIds,
              `case ${detail.id} step #${step.order} references endpoint ${step.endpoint_id}, ` +
                `which is not an endpoint of this project`,
            ).toContain(step.endpoint_id);
          }
          stepsChecked += 1;
        }
      }
      expect(stepsChecked, 'the grounding oracle inspected no step at all').toBeGreaterThan(0);
    });

    await test.step('the coverage map now reports the generated categories as covered', async () => {
      const after = await api.insights.getInsights(project.id);
      for (const id of requested) {
        const row = after.categories.find((c) => c.id === id);
        expect(row, `category ${id} vanished from the coverage map`).toBeDefined();
        expect(row!.covered_count, `category ${id} was generated but is not covered`).toBeGreaterThan(0);
        expect(row!.status).toBe('covered');
      }
    });
  });

  test('an illegal category id is refused with 422 invalid_category @negative', async ({
    api,
    project,
  }) => {
    await expectApiError(
      api.insights.generate(project.id, { categories: ['boundary_surprise', 'not_a_category'] }),
      { status: 422, code: 'invalid_category' },
    );
  });

  test('the insights page runs the engine and lands the drafts in the review queue', async ({
    api,
    asQaLead,
    project,
  }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    await groundProject(api, project.id);

    // The page renders whatever the API reports — assert the two agree per row
    // instead of hard-coding statuses the inventory decides.
    const summary = await api.insights.getInsights(project.id);
    const insights = new InsightsPage(asQaLead);

    await insights.goto(project.id);
    await expect(insights.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });
    await expect(insights.categoryRows).toHaveCount(EDGE_CATEGORIES.length);

    await test.step('each of the 9 rows carries its backend status as data-state', async () => {
      for (const category of EDGE_CATEGORIES) {
        const expected = summary.categories.find((c) => c.id === category);
        expect(expected, `the API omitted category ${category}`).toBeDefined();
        await expect(insights.statusOf(category)).toHaveAttribute('data-state', expected!.status);
      }
    });

    const gap = gapCategories(summary)[0];
    expect(gap, 'no gap category to drive the UI with').toBeDefined();

    await test.step(`select the "${gap}" gap and run the engine`, async () => {
      await insights.selectCategory(gap);
      expect(await insights.selectedCount()).toBe(1);
      await insights.generate(); // waits on the page's own result card
    });

    await expect(insights.resultCard).toBeVisible();
    await expect(insights.createdStat).toBeVisible();
    await expect(insights.discardedStat).toBeVisible();
    // The engine's own claim, checked against the API: the cases exist.
    const drafts = await api.review.list(project.id, { state: 'draft' });
    expect(drafts.filter((c) => c.edge_category === gap).length).toBeGreaterThan(0);

    await test.step('the result card leads to the new drafts in review', async () => {
      const review = new ReviewPage(asQaLead);
      await insights.goToReview();
      await expect(review.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });
      await expect(review.stateOfFirst).toHaveAttribute('data-state', 'draft');
    });
  });
});

/**
 * UI gating of the engine's only mutating control (frontend/lib/permissions.ts:
 * generate = admin|qa_lead|qa_engineer). Both directions are asserted, and each
 * probe first settles an anchor that renders for EVERY role — the empty state of
 * an ungrounded project, which appears only after the page has hydrated AND
 * GET /insights has resolved. Without that anchor a `toBeHidden` assertion could
 * pass vacuously against un-hydrated HTML (see permissions-ui.spec.ts).
 */
test.describe('insights permission gating @permission @regression', () => {
  test('viewer does not see insights-generate-button', async ({ asViewer, project }) => {
    const insights = new InsightsPage(asViewer);

    await insights.goto(project.id);
    await expect(insights.emptyState).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

    await expect(insights.generateControl).toBeHidden();
  });

  test('qa_engineer sees insights-generate-button', async ({ asQaEngineer, project }) => {
    const insights = new InsightsPage(asQaEngineer);

    await insights.goto(project.id);
    await expect(insights.emptyState).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

    await expect(insights.generateControl).toBeVisible();
  });
});
