/**
 * Project shell navigation — with an API-created project, every sidebar
 * section renders its `{domain}-page-root` (registry: docs/TESTID_REGISTRY.md).
 * Roots are asserted by testid, never by visible copy (§5, §6).
 *
 * This spec also carries the document-language guard: Traceo ships English-only
 * and left-to-right, and there is no runtime language mechanism left to flip it.
 */
import { test, expect } from '../fixtures';
import { PROJECT_SECTIONS, ProjectShellPage } from '../pages/project-shell.page';
import { ProjectsPage } from '../pages/projects.page';

test.describe('project navigation @smoke', () => {
  test('the document is served as English, left to right', async ({ asQaLead }) => {
    const projects = new ProjectsPage(asQaLead);

    await projects.goto();
    await expect(projects.root).toBeVisible({ timeout: 20_000 });

    // The <html> contract from frontend/app/layout.tsx — asserted AFTER
    // hydration has settled (the page root above proves it) so a client-side
    // override would be caught, not missed.
    const html = asQaLead.locator('html');
    await expect(html).toHaveAttribute('lang', 'en');
    await expect(html).toHaveAttribute('dir', 'ltr');
  });

  test('opening a project lands on its overview', async ({ asQaLead, project }) => {
    const shell = new ProjectShellPage(asQaLead);

    await shell.goto(project.id);

    await expect(shell.rootOf('overview')).toBeVisible();
  });

  for (const section of PROJECT_SECTIONS.filter((s) => s !== 'overview')) {
    test(`sidebar opens the ${section} page`, async ({ asQaLead, project }) => {
      const shell = new ProjectShellPage(asQaLead);

      await shell.goto(project.id);
      await shell.openSection(section);

      // Dev-server first navigation compiles the route on demand — allow for
      // cold-compile latency (per-kind timeout, §16; not a blanket sleep).
      await expect(shell.rootOf(section)).toBeVisible({ timeout: 20_000 });
    });
  }
});
