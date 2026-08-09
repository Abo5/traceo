/**
 * Project creation through the UI (manage_projects = admin|qa_lead —
 * backend/app/security.py).
 */
import { test, expect } from '../fixtures';
import { ProjectsPage } from '../pages/projects.page';
import { ProjectShellPage } from '../pages/project-shell.page';
import { uniqueSuffix } from '../helpers/unique';

test.describe('projects @smoke', () => {
  test('qa_lead creates a project through the UI and sees it listed', async ({ asQaLead }) => {
    const projects = new ProjectsPage(asQaLead);
    const name = `e2e-ui-${uniqueSuffix()}`;

    await projects.goto();
    // No language in the create dialog any more — it is auto-detected later
    // from the first parsed document (autopilot contract).
    await projects.createProject({ name });

    // Successful create redirects into the new project's overview
    // (frontend/app/projects/page.tsx — router.push after POST succeeds).
    await expect(new ProjectShellPage(asQaLead).projectName).toHaveText(name, { timeout: 20_000 });

    // Back on the list, the new project is listed.
    await projects.goto();
    await expect(projects.cardFor(name)).toBeVisible();
  });
});
