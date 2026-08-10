/**
 * Accessibility scans (@a11y, §18) — axe over every top-level surface:
 * the public auth pages, the projects list, and each project sub-page
 * (API-created project + storage-state auth, §9). The gate is delta-based:
 * only violations absent from e2e/a11y-baseline.json fail (see helpers/a11y.ts).
 * Page readiness is asserted on `{domain}-page-root` testids, never on
 * visible copy (§5, §6).
 */
import { test, expect } from '../fixtures';
import { checkA11y } from '../helpers/a11y';
import { sampleFile } from '../helpers/test-data';
import { EndpointsPage } from '../pages/endpoints.page';
import { LoginPage } from '../pages/login.page';
import { ProjectsPage } from '../pages/projects.page';
import { PROJECT_SECTIONS, ProjectShellPage } from '../pages/project-shell.page';
import { RegisterPage } from '../pages/register.page';
import { projectFactory } from '../test-data/project.factory';

test.describe('accessibility @a11y', () => {
  // Dev-server first navigation compiles the route on demand (up to ~20s),
  // and the axe scan itself adds a few seconds — widen the test budget.
  test.beforeEach(() => {
    test.setTimeout(60_000);
  });

  // `page` (no storage state) — the auth pages are public surfaces.
  test('login page has no new a11y violations', async ({ page }) => {
    const login = new LoginPage(page);

    await login.goto();
    await expect(login.root).toBeVisible({ timeout: 20_000 });

    await checkA11y(page, 'login');
  });

  test('register page has no new a11y violations', async ({ page }) => {
    const register = new RegisterPage(page);

    await register.goto();
    await expect(register.root).toBeVisible({ timeout: 20_000 });

    await checkA11y(page, 'register');
  });

  test('projects list has no new a11y violations', async ({ asQaLead }) => {
    const projects = new ProjectsPage(asQaLead);

    await projects.goto();
    await expect(projects.root).toBeVisible({ timeout: 20_000 });

    // Project cards are volatile: sibling tests' `project` fixtures append to
    // this org's list mid-run, so card count (and thus nth-child fingerprints)
    // is nondeterministic under fullyParallel — scan the page chrome only.
    await checkA11y(asQaLead, 'projects', { exclude: ['[data-testid="projects-list-card"]'] });
  });

  for (const section of PROJECT_SECTIONS) {
    test(`project ${section} page has no new a11y violations`, async ({
      asQaLead,
      project,
    }) => {
      const shell = new ProjectShellPage(asQaLead);

      await shell.goto(project.id);
      await expect(shell.rootOf('overview')).toBeVisible({ timeout: 20_000 });
      if (section !== 'overview') {
        await shell.openSection(section);
        await expect(shell.rootOf(section)).toBeVisible({ timeout: 20_000 });
      }

      await checkA11y(asQaLead, `project:${section}`);
    });
  }

  /**
   * The section loop above scans every project page EMPTY — which is the only
   * state most of them have under an isolated project. The endpoints page is
   * the exception worth a second scan: importing an API collection is what
   * makes its inventory table, its format badge and its AI-enrichment columns
   * exist at all, and none of those elements is reachable from the empty state.
   *
   * The scan reuses the EXISTING `project:endpoints` baseline key rather than
   * inventing a second one: both states are the same page, the baseline entry
   * is empty, and sharing the key means new markup cannot introduce debt on
   * either state without failing. Arrangement is API-side (§9) — this is an
   * accessibility scan, not an import test (that is tests/collections.spec.ts).
   */
  test('endpoints page with an imported inventory has no new a11y violations', async ({
    api,
    asQaLead,
  }) => {
    // "auto" rather than the manual `project` fixture: enrichment is gated on
    // that flag, and the AI badges are precisely the new elements this scan
    // exists to cover. Nothing else auto-runs — the autopilot needs confirmed
    // requirements, and this project has none.
    const project = await api.as('qa_lead').projects.create(projectFactory({ automation: 'auto' }));
    await api.discovery.importSpec(project.id, sampleFile('calendar-api.postman_collection.json'));

    const endpoints = new EndpointsPage(asQaLead);
    await endpoints.goto(project.id);
    await expect(endpoints.root).toBeVisible({ timeout: 20_000 });
    // Scan the SETTLED table, not the loading placeholder.
    await expect(endpoints.rows.first()).toBeVisible({ timeout: 20_000 });

    await checkA11y(asQaLead, 'project:endpoints');
  });
});
