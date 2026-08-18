/**
 * A project declares which of the five kinds of testing it is for
 * (@critical @regression).
 *
 * The choice is made when the project is created and can be changed afterwards
 * from Overview, and it is not decoration: it is the ceiling on what the
 * project's engines will do. What this spec holds onto is the pair of
 * properties that make that trustworthy —
 *
 *   1. THE DECLARATION IS OBEYED. A discovery that names no types runs exactly
 *      what the project declared, and one that names a type the project
 *      excluded is REFUSED with a typed error naming what the project is for.
 *      Silently narrowing would be the worst outcome: the report would say a
 *      track succeeded when it never ran.
 *   2. THE UI CANNOT OFFER WHAT THE SERVER REFUSES. The five buttons are one
 *      component reading one vocabulary, so an out-of-scope type is rendered
 *      disabled rather than as a control that always fails.
 *
 * The API-level contract (canonical order, unknown values, the empty list, and
 * a row that predates the field) is pinned in backend/tests and backend-go/tests
 * on both engines; this spec covers the wire and the screens.
 */
import { test, expect } from '../fixtures';
import { routes } from '../constants/routes';
import { WEB_TARGET_TEST_TYPES, type WebTargetTestType } from '../constants/states';
import { expectApiError } from '../helpers/expect-api-error';
import { uniqueSuffix } from '../helpers/unique';
import { ProjectsPage } from '../pages/projects.page';

const ALL_FIVE = [...WEB_TARGET_TEST_TYPES] as WebTargetTestType[];

test.describe('project test types — API @regression', () => {
  test('a project created without a choice is for every type', async ({ api }) => {
    const project = await api.as('qa_lead').projects.create({ name: `tt-${uniqueSuffix()}` });
    expect(project.test_types).toEqual(ALL_FIVE);
  });

  test('a declared subset is stored, canonically ordered, and read back', async ({ api }) => {
    // out of order and with a duplicate — neither may change what runs
    const project = await api.as('qa_lead').projects.create({
      name: `tt-${uniqueSuffix()}`,
      test_types: ['security', 'ui', 'security'],
    });
    expect(project.test_types).toEqual(['ui', 'security']);
    expect((await api.as('qa_lead').projects.get(project.id)).test_types).toEqual(['ui', 'security']);
  });

  test('an unknown type is refused and the legal list is named @negative', async ({ api }) => {
    const error = await expectApiError(
      api.as('qa_lead').projects.create({
        name: `tt-${uniqueSuffix()}`,
        test_types: ['functional', '__traceo_not_a_test_type__'],
      }),
      { status: 422, code: 'invalid_test_type' },
    );
    // the caller is told what IS allowed, not merely that it was wrong
    expect(error.errors.sort()).toEqual([...ALL_FIVE].sort());
  });

  test('a discovery with no types named runs the project declaration', async ({ api }) => {
    const project = await api.as('qa_lead').projects.create({
      name: `tt-${uniqueSuffix()}`,
      test_types: ['ui', 'security'],
    });
    // The URL is never reached: the request is accepted (202) and what matters
    // here is the echoed selection, which is decided before any browsing.
    const accepted = await api.as('qa_lead').webTargets.create(project.id, {
      url: 'https://traceo-unreached.invalid/page',
    });
    expect(accepted.test_types).toEqual(['ui', 'security']);
  });

  test('a discovery cannot ask for a type the project excluded @negative', async ({ api }) => {
    const project = await api.as('qa_lead').projects.create({
      name: `tt-${uniqueSuffix()}`,
      test_types: ['ui'],
    });
    const error = await expectApiError(
      api.as('qa_lead').webTargets.create(project.id, {
        url: 'https://traceo-unreached.invalid/page',
        test_types: ['ui', 'security'],
      }),
      { status: 422, code: 'test_type_not_in_project' },
    );
    expect(error.message).toContain('security');
    expect(error.errors).toEqual(['ui']); // what this project IS set up for
  });
});

test.describe('project test types — UI @regression', () => {
  test('the create dialog offers the five, all on, and stores the narrowed choice', async ({
    asQaLead,
    api,
  }) => {
    const projects = new ProjectsPage(asQaLead);
    const name = `tt-ui-${uniqueSuffix()}`;

    await projects.goto();
    await expect(projects.root).toBeVisible({ timeout: 20_000 });
    await asQaLead.getByTestId('projects-list-create-button').click();

    await expect(asQaLead.getByTestId('projects-create-type-row')).toHaveCount(5);
    for (const type of ALL_FIVE) {
      await expect(asQaLead.getByTestId(`projects-create-type-${type}`)).toBeChecked();
    }

    for (const type of ['functional', 'api', 'performance'] as const) {
      await asQaLead.getByTestId(`projects-create-type-${type}`).uncheck();
    }
    await asQaLead.getByTestId('projects-create-name-input').fill(name);
    await asQaLead.getByTestId('projects-create-submit-button').click();
    await asQaLead.waitForURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 20_000 });

    // asserted on the server, not on the screen that just wrote it
    const created = (await api.as('qa_lead').projects.list()).find((p) => p.name === name);
    expect(created, 'the project must exist').toBeTruthy();
    expect(created!.test_types).toEqual(['ui', 'security']);
  });

  test('clearing every type disables the create button', async ({ asQaLead }) => {
    const projects = new ProjectsPage(asQaLead);

    await projects.goto();
    await expect(projects.root).toBeVisible({ timeout: 20_000 });
    await asQaLead.getByTestId('projects-list-create-button').click();
    await asQaLead.getByTestId('projects-create-name-input').fill(`tt-${uniqueSuffix()}`);

    for (const type of ALL_FIVE) {
      await asQaLead.getByTestId(`projects-create-type-${type}`).uncheck();
    }
    // a project that tests nothing cannot be submitted at all
    await expect(asQaLead.getByTestId('projects-create-submit-button')).toBeDisabled();
    await expect(asQaLead.getByTestId('projects-create-types-hint')).toBeVisible();
  });

  test('Overview shows the declaration and saves a change', async ({ asQaLead, api }) => {
    const project = await api.as('qa_lead').projects.create({
      name: `tt-overview-${uniqueSuffix()}`,
      test_types: ALL_FIVE,
    });

    await asQaLead.goto(routes.project(project.id));
    await expect(asQaLead.getByTestId('project-types-card')).toBeVisible({ timeout: 20_000 });
    for (const type of ALL_FIVE) {
      await expect(asQaLead.getByTestId(`project-type-${type}`)).toBeChecked();
    }

    await asQaLead.getByTestId('project-type-performance').uncheck();
    await asQaLead.getByTestId('project-types-save-button').click();
    await expect(asQaLead.getByTestId('project-types-save-button')).toHaveCount(0);

    const stored = await api.as('qa_lead').projects.get(project.id);
    expect(stored.test_types).toEqual(['functional', 'api', 'ui', 'security']);
  });

  test('the Target screen offers only what the project is for', async ({ asQaLead, api }) => {
    const project = await api.as('qa_lead').projects.create({
      name: `tt-target-${uniqueSuffix()}`,
      test_types: ['ui', 'security'],
    });

    await asQaLead.goto(routes.target(project.id));
    await expect(asQaLead.getByTestId('target-url-input')).toBeVisible({ timeout: 20_000 });

    for (const type of ['ui', 'security'] as const) {
      await expect(asQaLead.getByTestId(`target-type-${type}`)).toBeChecked();
      await expect(asQaLead.getByTestId(`target-type-${type}`)).toBeEnabled();
    }
    for (const type of ['functional', 'api', 'performance'] as const) {
      // disabled, not merely unchecked: the server would refuse it, so the UI
      // must not offer a control that always fails
      await expect(asQaLead.getByTestId(`target-type-${type}`)).not.toBeChecked();
      await expect(asQaLead.getByTestId(`target-type-${type}`)).toBeDisabled();
    }
    await expect(asQaLead.getByTestId('target-types-scope-hint')).toBeVisible();
  });

  test('a URL given at creation lands on Target and runs by itself', async ({
    asQaLead,
    api,
  }) => {
    // The point of the field: a project and its first discovery in one action,
    // with no hunt through the sidebar for where a URL goes.
    const projects = new ProjectsPage(asQaLead);
    const name = `tt-oneshot-${uniqueSuffix()}`;

    await projects.goto();
    await expect(projects.root).toBeVisible({ timeout: 20_000 });
    await asQaLead.getByTestId('projects-list-create-button').click();
    await asQaLead.getByTestId('projects-create-name-input').fill(name);
    await asQaLead
      .getByTestId('projects-create-url-input')
      .fill('https://traceo-unreached.invalid/page');
    await asQaLead.getByTestId('projects-create-submit-button').click();

    // it lands on the discovery screen with the URL already in the field
    await asQaLead.waitForURL(/\/projects\/[0-9a-f-]{36}\/target/, { timeout: 20_000 });
    await expect(asQaLead.getByTestId('target-url-input'))
      .toHaveValue('https://traceo-unreached.invalid/page', { timeout: 20_000 });

    // and it really started one: the target row exists without anyone pressing
    // Start. (The host does not resolve, so the JOB fails — that is the target's
    // problem, not the flow's, and the row is the evidence the flow ran.)
    const created = (await api.as('qa_lead').projects.list()).find((p) => p.name === name);
    expect(created, 'the project must exist').toBeTruthy();
    await expect
      .poll(async () => (await api.as('qa_lead').webTargets.list(created!.id)).length, {
        timeout: 30_000,
        message: 'the discovery must start without a second click',
      })
      .toBe(1);

    // the query string is cleared, so a refresh cannot launch a second discovery
    expect(new URL(asQaLead.url()).search).toBe('');
  });

  test('a viewer sees the declaration but cannot change it @permission', async ({
    asViewer,
    api,
  }) => {
    const project = await api.as('qa_lead').projects.create({
      name: `tt-viewer-${uniqueSuffix()}`,
      test_types: ['api'],
    });

    await asViewer.goto(routes.project(project.id));
    await expect(asViewer.getByTestId('project-types-card')).toBeVisible({ timeout: 20_000 });
    await expect(asViewer.getByTestId('project-type-api')).toBeChecked();
    await expect(asViewer.getByTestId('project-type-api')).toBeDisabled();
    await expect(asViewer.getByTestId('project-types-readonly-hint')).toBeVisible();
  });
});
