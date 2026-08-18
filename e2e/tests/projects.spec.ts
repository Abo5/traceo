/**
 * Project creation through the UI (manage_projects = admin|qa_lead —
 * backend/app/security.py).
 *
 * Two entry points reach the SAME create dialog: the prominent header button
 * (`projects-list-create-button`) and the empty-state call to action
 * (`projects-empty-create-button`). Both are covered here — the empty-state one
 * against a freshly registered org, because the worker org's list is never
 * empty while specs run in parallel.
 */
import { test, expect } from '../fixtures';
import { registerFreshOrg } from '../helpers/fresh-org';
import { uniqueSuffix } from '../helpers/unique';
import { ProjectsPage } from '../pages/projects.page';
import { ProjectShellPage } from '../pages/project-shell.page';

/** Dev-server first navigation compiles the route on demand (§16). */
const FIRST_VISIT_TIMEOUT_MS = 20_000;

test.describe('projects @smoke', () => {
  test('qa_lead creates a project through the UI and sees it listed', async ({ asQaLead }) => {
    const projects = new ProjectsPage(asQaLead);
    const name = `e2e-ui-${uniqueSuffix()}`;

    await projects.goto();
    // Name is the whole form: automation defaults to "auto" server-side and a
    // project has no language (Traceo is English-only).
    await projects.createProject({ name });

    // Successful create redirects into the new project's overview
    // (frontend/app/projects/page.tsx — router.push after POST succeeds).
    await expect(new ProjectShellPage(asQaLead).projectName).toHaveText(name, { timeout: 20_000 });

    // Back on the list, the new project is listed.
    await projects.goto();
    await expect(projects.cardFor(name)).toBeVisible();
  });

  test('the empty state offers a create call to action that opens the same dialog', async ({
    browser,
  }) => {
    // A brand-new org — the only state in which /projects is genuinely empty.
    const org = await registerFreshOrg();
    const context = await browser.newContext({ storageState: org.storageState });
    const page = await context.newPage();

    try {
      const projects = new ProjectsPage(page);
      const name = `e2e-empty-${uniqueSuffix()}`;

      await projects.goto();
      await expect(projects.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });
      await expect(projects.emptyState).toBeVisible();

      // Both entry points are offered; the empty-state one is the one under test.
      await expect(projects.createControl).toBeVisible();
      await expect(projects.emptyCreateControl).toBeVisible();

      await projects.openCreateModalFromEmptyState();
      await expect(projects.createDialog).toBeVisible();

      await projects.submitCreateForm(name);

      // Same dialog, same outcome as the header button: straight into the new
      // project's overview, and the empty state is gone from the list.
      await expect(new ProjectShellPage(page).projectName).toHaveText(name, {
        timeout: FIRST_VISIT_TIMEOUT_MS,
      });
      await projects.goto();
      await expect(projects.cardFor(name)).toBeVisible();
      await expect(projects.emptyState).toBeHidden();
    } finally {
      await context.close();
    }
  });
});
