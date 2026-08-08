/**
 * Fixtures — the DI seam (§9). No assertions, no business logic.
 *
 * Lifetimes: `api` is worker-scoped and bound to the run org (the safe
 * alternative to a singleton, §4 — the server itself enforces tenant
 * isolation). Role pages, `project` and `generatedCase` are per-test.
 * No teardown by design: the org is isolated and disposable (§8).
 */
import { test as base, type Browser, type Page } from '@playwright/test';
import { ApiClient } from '../api/client';
import type { Project, TestCase } from '../api/types';
import type { Role } from '../constants/roles';
import { authStatePath } from '../helpers/paths';
import { sampleFile } from '../helpers/test-data';
import { projectFactory } from '../test-data/project.factory';

type TraceoFixtures = {
  /** Authenticated page per role — storage state composed by global/auth.setup.ts. */
  asAdmin: Page;
  asQaLead: Page;
  asQaEngineer: Page;
  asViewer: Page;
  /** A project owned by this test alone. */
  project: Project;
  /** A draft case produced by the full pipeline (mock LLM — deterministic). */
  generatedCase: TestCase;
};

type TraceoWorkerFixtures = {
  /** qa_engineer by default (fast setup path); escalate via api.as('qa_lead'). */
  api: ApiClient;
};

async function rolePage(
  browser: Browser,
  role: Role,
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const ctx = await browser.newContext({ storageState: authStatePath(role) });
  await use(await ctx.newPage());
  await ctx.close();
}

export const test = base.extend<TraceoFixtures, TraceoWorkerFixtures>({
  api: [
    async ({}, use) => {
      const client = await ApiClient.forWorkerOrg();
      await use(client);
      await client.dispose();
    },
    { scope: 'worker' },
  ],

  asAdmin: async ({ browser }, use) => rolePage(browser, 'admin', use),
  asQaLead: async ({ browser }, use) => rolePage(browser, 'qa_lead', use),
  asQaEngineer: async ({ browser }, use) => rolePage(browser, 'qa_engineer', use),
  asViewer: async ({ browser }, use) => rolePage(browser, 'viewer', use),

  project: async ({ api }, use) => {
    // manage_projects requires admin|qa_lead (backend/app/security.py)
    const project = await api.as('qa_lead').projects.create(projectFactory());
    await use(project); // no teardown — the org is isolated and disposable
  },

  generatedCase: async ({ api, project }, use) => {
    await api.ingestion.uploadAndConfirm(project.id, sampleFile('sample_requirements_ar.md'));
    await api.discovery.importSpec(project.id, sampleFile('sample_openapi.yaml'));
    const cases = await api.generation.generateAndWait(project.id);
    const draft = cases.find((c) => c.state === 'draft');
    if (!draft) {
      throw new Error(
        `generatedCase fixture: pipeline produced no draft case in project ${project.id} ` +
          `(got ${cases.length} case(s): ${cases.map((c) => c.state).join(', ') || 'none'})`,
      );
    }
    await use(draft);
  },
});

export { expect } from '../assertions/traceo.matchers';
