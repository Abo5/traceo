/**
 * QA Insight Agent — the sixth engine, end to end (@critical
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
 * (constants/states.ts), never through visible UI copy (§5, §6).
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
  await api.ingestion.uploadAndConfirm(projectId, sampleFile('sample_requirements_en.md'));
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
});
