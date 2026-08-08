/**
 * i18n-lane locators not exposed by the existing page objects (those files are
 * owned by other lanes and expose these controls as private). data-testid-only
 * (§5); expected label text always comes from helpers/i18n-dictionary.ts,
 * never hardcoded bilingual strings (§6). No assertions here.
 */
import type { Locator, Page } from '@playwright/test';

/** Login form submit button — its idle label is the dictionary's 'login'. */
export function loginSubmitButton(page: Page): Locator {
  return page.getByTestId('login-form-submit-button');
}

/** Create-project button on /projects — its label contains 'new_project'. */
export function projectsCreateButton(page: Page): Locator {
  return page.getByTestId('projects-list-create-button');
}

/** The <html> element — carrier of the document-level lang/dir contract. */
export function documentRoot(page: Page): Locator {
  return page.locator('html');
}
