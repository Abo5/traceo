/**
 * Project shell navigation — with an API-created project, every sidebar
 * section renders its `{domain}-page-root` (registry: docs/TESTID_REGISTRY.md).
 * Roots are asserted by testid, never by bilingual text (§5, §6).
 */
import { test, expect } from '../fixtures';
import { PROJECT_SECTIONS, ProjectShellPage } from '../pages/project-shell.page';

test.describe('project navigation @smoke', () => {
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
