/**
 * The public landing page (frontend/app/landing).
 *
 * Two properties matter here and neither is cosmetic.
 *
 * It is PUBLIC: it renders with no session and no app chrome. A marketing page
 * that cannot be read until the backend answers is a marketing page that is
 * down whenever the backend is, so this spec drives it from an anonymous page
 * fixture and asserts the shell is absent rather than merely invisible.
 *
 * Its EXPLANATION IS THE ANIMATION: the four acts drive a WebGL scene, and
 * repairing a defect hands the visitor the same artefact the product hands
 * them — a fix prompt ending in the line backend/app/modules/fixprompt.py
 * closes with. If that link breaks, the page is advertising something the
 * product no longer does.
 *
 * Locators come from LandingPage (§5, §7); readiness is the scene's own
 * data-ready flag, never a fixed wait (§16).
 */
import { test, expect } from '../fixtures';
import { checkA11y } from '../helpers/a11y';
import { LandingPage } from '../pages/landing.page';
import { routes } from '../constants/routes';

test.describe('landing page @smoke', () => {
  // The scene lazy-loads three and the dev server compiles the route on demand.
  test.beforeEach(() => {
    test.setTimeout(60_000);
  });

  test('renders for a signed-out visitor, with no application chrome', async ({ page }) => {
    const landing = new LandingPage(page);

    await landing.goto();

    await expect(landing.root).toBeVisible({ timeout: 20_000 });
    await expect(landing.hero).toBeVisible();
    // The shell is not merely hidden here — it is never mounted.
    await expect(page.getByTestId('nav-rail')).toHaveCount(0);
    await expect(page.getByTestId('nav-topbar')).toHaveCount(0);
  });

  test('the hero scene starts', async ({ page }) => {
    const landing = new LandingPage(page);

    await landing.goto();
    await landing.waitForScene();

    // data-ready proves the scene was constructed; the canvas proves a surface
    // exists to draw on. Neither alone is evidence the animation is running.
    await expect(landing.canvas).toHaveAttribute('data-ready', '1');
    await expect(landing.canvas.locator('canvas')).toBeVisible();
  });

  test('every act of the explanation is on the page', async ({ page }) => {
    const landing = new LandingPage(page);

    await landing.goto();
    await landing.waitForScene();

    for (const act of [1, 2, 3, 4] as const) {
      await landing.openAct(act);
      await expect(landing.act(act)).toBeVisible();
    }
  });

  test('the call to action leads into the application', async ({ page }) => {
    const landing = new LandingPage(page);

    await landing.goto();

    await expect(landing.appCallToAction).toHaveAttribute('href', routes.projects);
  });
});

test.describe('landing page — the fix loop', () => {
  test.beforeEach(() => {
    test.setTimeout(60_000);
  });

  test('repairing the defects yields a fix prompt in the product\'s own shape', async ({ page }) => {
    const landing = new LandingPage(page);

    await landing.goto();
    await landing.waitForScene();
    await landing.openAct(4);

    await expect(landing.bugBar).toContainText('3 defects');
    await expect(landing.fixPrompt).toHaveCount(0);

    await landing.fixEveryDefect();

    await expect(landing.fixPrompt).toBeVisible();
    await expect(landing.bugBar).toContainText('All clear');
    // The one line every generated prompt ends with. It is the product's
    // position on what a passing test is allowed to mean, so the page must not
    // quietly drop it (backend/app/modules/fixprompt.py).
    await expect(landing.fixPrompt).toContainText('Change the application, not the test');
    await expect(landing.fixPrompt).toContainText('Requirement');
  });
});

test.describe('landing page — sign in', () => {
  test.beforeEach(() => {
    test.setTimeout(60_000);
  });

  test('the model frames a real credentials form, not a picture of one', async ({ page }) => {
    const landing = new LandingPage(page);

    await landing.goto();
    await landing.waitForScene();
    await landing.signIn.scrollIntoViewIfNeeded();

    // The frame is WebGL; the inputs are not. A password field has to be a
    // password field or the browser cannot mask it, autofill it, or offer to
    // save it, and a screen reader cannot announce what it is.
    await expect(landing.signInPassword).toHaveAttribute('type', 'password');
    await expect(landing.signInPassword).toHaveAttribute('autocomplete', 'current-password');
    await expect(landing.signInEmail).toHaveAttribute('type', 'email');
  });

  test('a refused sign-in says what the server said @negative', async ({ page }) => {
    const landing = new LandingPage(page);

    await landing.goto();
    await landing.waitForScene();
    await landing.signIn.scrollIntoViewIfNeeded();

    await landing.signInWith('nobody@traceo.invalid', 'not-the-password');

    // The server's own words. "Something went wrong" in front of a password
    // field is the least useful sentence in software.
    await expect(landing.signInError).toBeVisible({ timeout: 20_000 });
    await expect(landing.signInError).toContainText(/invalid|incorrect|password/i);
    // and it must not have let anyone through
    await expect(page).toHaveURL(/\/landing/);
  });
});

test.describe('landing page @a11y', () => {
  test.beforeEach(() => {
    test.setTimeout(60_000);
  });

  test('has no new a11y violations', async ({ page }) => {
    const landing = new LandingPage(page);

    await landing.goto();
    await landing.waitForScene();

    await checkA11y(page, 'landing');
  });
});
