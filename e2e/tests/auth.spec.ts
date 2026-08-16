/**
 * Signing in was removed from this build, and this spec is what keeps it
 * removed.
 *
 * It replaces the former UI login-flow tests. Those exercised a screen that no
 * longer exists; asserting on it now would only prove that a deleted page stays
 * deleted by accident. What matters instead is the property the removal was
 * asked for: **no route can strand a user at a credentials form**. So this
 * checks the routes themselves — that /login and /register do not resolve, and
 * that neither the root nor the application shell offers a way to reach one.
 *
 * These hold regardless of how the backend is configured, which matters here:
 * this suite deliberately runs against a backend with `TRACEO_DEV_AUTOLOGIN`
 * OFF (pinned by negative.spec.ts), so nothing below may depend on a session
 * being handed out for free.
 *
 * The HTTP API keeps its /auth/login and /auth/register endpoints: they are the
 * product's authentication surface, the suite composes its role sessions from
 * them (global/auth.setup.ts), and a backend without the dev-session flag still
 * authenticates normally. Removing the browser screens is a decision about this
 * build's UI, not a claim that the system has no authentication.
 */
import { test, expect } from '../fixtures';
import { routes } from '../constants/routes';
import { ProjectsPage } from '../pages/projects.page';

test.describe('no-login build @smoke', () => {
  for (const route of [routes.login, routes.register] as const) {
    test(`${route} does not resolve — the screen is gone, not hidden`, async ({ page }) => {
      // A redirect would still leave a page to land on if the guard ever broke;
      // the route must not exist at all, which the server answers as 404.
      const response = await page.goto(route, { waitUntil: 'domcontentloaded' });

      expect(response?.status(), `${route} must not be served`).toBe(404);
      // and nothing resembling a credentials form came back with it
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
    });
  }

  test('the root offers no credentials form and no way to reach one', async ({ page }) => {
    await page.goto(routes.home, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(
      page.locator(`a[href="${routes.login}"], a[href="${routes.register}"]`),
    ).toHaveCount(0);
  });

  test('the application shell carries no sign-out control', async ({ asQaLead }) => {
    // Sign-out existed only to return the user to a login screen; with that
    // screen gone the control would lead nowhere, so it is gone too.
    const projects = new ProjectsPage(asQaLead);

    await projects.goto();
    await expect(projects.root).toBeVisible({ timeout: 20_000 });

    await expect(asQaLead.getByRole('button', { name: /log ?out|sign ?out/i })).toHaveCount(0);
    await expect(
      asQaLead.locator(`a[href="${routes.login}"], a[href="${routes.register}"]`),
    ).toHaveCount(0);
  });
});
