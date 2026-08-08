/**
 * @i18n lane — the UI language comes from localStorage `traceo_lang`
 * (frontend/lib/i18n.ts). Every test runs in a context whose qa_lead storage
 * state has the language overridden (helpers/lang-state.ts — auth states stay
 * composed by global/auth.setup.ts, never duplicated). Page roots are asserted
 * by testid; visible labels are resolved from the production dictionary
 * (helpers/i18n-dictionary.ts), never hardcoded bilingual strings (§5, §6).
 *
 * Document contract (verified against the running app): frontend/app/layout.tsx
 * hardcodes `<html lang="ar" dir="rtl">` in the SSR shell, but
 * frontend/components/providers.tsx syncs both attributes to `traceo_lang`
 * after hydration (applyDocumentLang). The settled post-hydration values are
 * therefore the current contract: rtl/ar for 'ar', ltr/en for 'en'.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import type { TestLang } from '../config/resolve';
import { uiText } from '../helpers/i18n-dictionary';
import { documentRoot, loginSubmitButton, projectsCreateButton } from '../helpers/i18n-ui';
import { qaLeadStateWithLang } from '../helpers/lang-state';
import { LoginPage } from '../pages/login.page';
import { ProjectsPage } from '../pages/projects.page';
import { PROJECT_SECTIONS, ProjectShellPage } from '../pages/project-shell.page';

const LANGS: readonly TestLang[] = ['ar', 'en'];

/** Post-hydration <html> attributes per stored language (see header comment). */
const DOCUMENT_ATTRS: Record<TestLang, { lang: string; dir: string }> = {
  ar: { lang: 'ar', dir: 'rtl' },
  en: { lang: 'en', dir: 'ltr' },
};

for (const lang of LANGS) {
  test.describe(`ui language ${lang} @i18n`, () => {
    let context: BrowserContext;
    let page: Page;

    test.beforeEach(async ({ browser }) => {
      context = await browser.newContext({ storageState: qaLeadStateWithLang(lang) });
      page = await context.newPage();
    });

    test.afterEach(async () => {
      await context.close();
    });

    test('login page renders with its dictionary label', async () => {
      const login = new LoginPage(page);

      await login.goto();

      await expect(login.root).toBeVisible({ timeout: 20_000 });
      await expect(loginSubmitButton(page)).toHaveText(uiText(lang, 'login'));
    });

    test('projects page renders with its dictionary label', async () => {
      const projects = new ProjectsPage(page);

      await projects.goto();

      await expect(projects.root).toBeVisible({ timeout: 20_000 });
      // rendered as `+ {label}` — the dictionary string is the label proper
      await expect(projectsCreateButton(page)).toContainText(uiText(lang, 'new_project'));
    });

    test('opening a project lands on its overview', async ({ project }) => {
      const shell = new ProjectShellPage(page);

      await shell.goto(project.id);

      await expect(shell.rootOf('overview')).toBeVisible({ timeout: 20_000 });
    });

    for (const section of PROJECT_SECTIONS.filter((s) => s !== 'overview')) {
      test(`sidebar opens the ${section} page`, async ({ project }) => {
        const shell = new ProjectShellPage(page);

        await shell.goto(project.id);
        await shell.openSection(section);

        // Dev-server first navigation compiles the route on demand — allow for
        // cold-compile latency (per-kind timeout, §16; not a blanket sleep).
        await expect(shell.rootOf(section)).toBeVisible({ timeout: 20_000 });
      });
    }

    test('document lang/dir settle to the stored language', async () => {
      const projects = new ProjectsPage(page);

      await projects.goto();
      await expect(projects.root).toBeVisible({ timeout: 20_000 });

      const html = documentRoot(page);
      await expect(html).toHaveAttribute('lang', DOCUMENT_ATTRS[lang].lang);
      await expect(html).toHaveAttribute('dir', DOCUMENT_ATTRS[lang].dir);
    });
  });
}
