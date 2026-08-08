/**
 * UI login flow — the one auth path exercised through the browser (§9: role
 * sessions are otherwise composed via API storage states; the login UI itself
 * is covered here as a test, not as setup).
 */
import { test, expect } from '../fixtures';
import { LoginPage } from '../pages/login.page';
import { ProjectsPage } from '../pages/projects.page';

test.describe('authentication @smoke', () => {
  test('a user provisioned via API logs in through the UI and lands on /projects', async ({
    page, // plain unauthenticated page — no storage state
    api,
  }) => {
    const { email, password } = api.actor('qa_engineer');
    const login = new LoginPage(page);
    const projects = new ProjectsPage(page);

    await login.goto();
    await login.logIn(email, password);

    // redirect to /projects proven by its page root rendering
    await expect(projects.root).toBeVisible();
  });

  test('failed login shows an error and stays on the login page', async ({ page }) => {
    const login = new LoginPage(page);

    await login.goto();
    await login.logIn('nobody@traceo.test', 'definitely-wrong-password');

    await expect(login.errorText).toBeVisible();
    await expect(login.root).toBeVisible();
  });
});
