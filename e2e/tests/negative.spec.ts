/**
 * Negative paths (@negative @regression) — the system refuses wrong input on
 * BOTH sides of the contract: the UI surfaces errors / withholds submission,
 * and the API refuses with the uniform `{code, message}` shape (asserted on
 * ApiError.code + status, never on message text — §6/§11).
 *
 * Backend sources of truth (read, not assumed):
 * - identity.py login: failure is a GENERIC 401 `invalid_credentials` — the
 *   response never reveals which field was wrong (NFR-SEC).
 * - identity.py register: duplicate email → 409 `email_taken`.
 * - deps.py get_project_scoped: a foreign tenant sees 404 `not_found`, never
 *   403 — existence must not leak across orgs (NFR-SEC-04, FR-USR-04).
 * - execution.py create_run: only `approved` cases are executable; a project
 *   whose cases are all draft answers 409 `no_approved_cases`.
 */
import { test, expect } from '../fixtures';
import { config } from '../config/resolve';
import { expectApiError } from '../helpers/expect-api-error';
import { registerForeignOrg } from '../helpers/foreign-org';
import { ProjectCreateModalProbe } from '../helpers/project-create-modal.probe';
import { uniqueSuffix } from '../helpers/unique';
import { LoginPage } from '../pages/login.page';
import { ProjectsPage } from '../pages/projects.page';
import { RegisterPage } from '../pages/register.page';

test.describe('negative paths — UI @negative @regression', () => {
  test('login with a wrong password shows the error and stays on the login page', async ({
    page, // plain unauthenticated page
    api,
  }) => {
    // A REAL provisioned email with the wrong password — the UI failure must be
    // indistinguishable from an unknown email (identity.py: generic 401).
    const { email } = api.actor('qa_engineer');
    const login = new LoginPage(page);

    await login.goto();
    await login.logIn(email, `wrong-${uniqueSuffix()}`);

    await expect(login.errorText).toBeVisible({ timeout: 20_000 });
    await expect(login.root).toBeVisible(); // no redirect — still on /login
  });

  test('registering with an already-used email surfaces an error on the form', async ({
    page,
    api,
  }) => {
    const taken = api.actor('viewer').email; // provisioned this run → guaranteed taken
    const register = new RegisterPage(page);

    await register.goto();
    await register.register({
      orgName: `e2e-dup-${uniqueSuffix()}`,
      name: 'E2E Duplicate',
      email: taken,
      password: 'E2e-pass-12345',
    });

    // 409 email_taken surfaces in the form's error slot; no redirect happens.
    await expect(register.errorText).toBeVisible({ timeout: 20_000 });
    await expect(register.root).toBeVisible();
  });

  test('project create with an empty name is prevented — submit stays disabled', async ({
    asQaLead, // manage_projects = admin|qa_lead (backend/app/security.py)
  }) => {
    const projects = new ProjectsPage(asQaLead);
    const modal = new ProjectCreateModalProbe(asQaLead);

    await projects.goto();
    await expect(projects.root).toBeVisible({ timeout: 20_000 });
    await modal.open();

    // Untouched (empty) name → the frontend withholds submission entirely.
    await expect(modal.submitButton).toBeDisabled();

    // Whitespace-only is equally empty (page.tsx disables on !name.trim()).
    await modal.nameInput.fill('   ');
    await expect(modal.submitButton).toBeDisabled();
    await expect(modal.dialog).toBeVisible(); // nothing was submitted, dialog still open
  });
});

test.describe('negative paths — API @negative @regression', () => {
  test('invalid login is refused with the generic 401 invalid_credentials', async ({ api }) => {
    const { email } = api.actor('qa_engineer');
    await expectApiError(api.identity.login(email, `wrong-${uniqueSuffix()}`), {
      status: 401,
      code: 'invalid_credentials',
    });
  });

  test('cross-org access answers 404, never 403 — tenant isolation (NFR-SEC-04)', async ({
    api,
    project,
  }) => {
    // Sanity: the owner org can read its own project.
    expect((await api.projects.get(project.id)).id).toBe(project.id);

    const foreign = await registerForeignOrg();
    try {
      // deps.py get_project_scoped: the 404 body is indistinguishable from a
      // nonexistent id — a 403 here would leak that the project exists.
      await expectApiError(foreign.projects.get(project.id), {
        status: 404,
        code: 'not_found',
      });
    } finally {
      await foreign.dispose();
    }
  });

  test('a run cannot start while every case is still draft (409 no_approved_cases)', async ({
    api,
    generatedCase, // full pipeline output — cases exist, but none approved
  }) => {
    const projectId = generatedCase.project_id;
    expect(generatedCase).toBeInState('draft');

    const env = await api.as('qa_lead').projects.createEnvironment(projectId, {
      name: `e2e-env-${uniqueSuffix()}`,
      base_url: config.sutUrl,
    });

    // execution.py create_run filters state == 'approved' — draft cases do not
    // qualify, so the run is refused before anything is queued.
    await expectApiError(api.runs.create(projectId, { environment_id: env.id }), {
      status: 409,
      code: 'no_approved_cases',
    });
  });
});
