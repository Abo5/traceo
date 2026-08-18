/**
 * Full UI pipeline journey — the ENTIRE Traceo flow driven through the UI as
 * qa_lead (unlike pipeline.spec.ts, which arranges the pipeline over the API):
 *
 *   upload requirements .md → parse job (watched on the document badge)
 *   → confirm all → import OpenAPI spec (endpoints page) → generate (the page
 *   waits its own job surface) → approve on the review page → create the
 *   demo-SUT environment (environments page UI) → launch a run → completion
 *   watched on the history row badge → run report → traceability matrix (BO-07).
 *
 * It is the UI counterpart of backend/tests/test_flow.py. Every state is
 * asserted via data-state with literal model values, never visible copy
 * (§5, §6). Async job waits are web-first assertions with per-kind budgets —
 * no waitForTimeout anywhere (§16). Sample data mirrors demo/: REQ-001 maps
 * deterministically to POST /auth/login under the mock LLM, so its coverage
 * on the matrix is a stable end-to-end trace assertion.
 */
import { test, expect } from '../fixtures';
import { config } from '../config/resolve';
import { samplePath } from '../helpers/test-data';
import { EndpointsPage } from '../pages/endpoints.page';
import { EnvironmentsPage } from '../pages/environments.page';
import { GeneratePage } from '../pages/generate.page';
import { MatrixPage } from '../pages/matrix.page';
import { RequirementsPage } from '../pages/requirements.page';
import { ReviewPage } from '../pages/review.page';
import { RunReportPage } from '../pages/run-report.page';
import { RunsPage } from '../pages/runs.page';

/** Dev-server first navigation compiles the route on demand (§16). */
const FIRST_VISIT_TIMEOUT_MS = 20_000;
/** UI budget for the ingest (parse) job — parse is shorter than generate. */
const PARSE_UI_TIMEOUT_MS = 90_000;
/** UI budget for the execute job against the demo SUT (:9000). */
const RUN_UI_TIMEOUT_MS = 180_000;

const REQUIREMENTS_DOC = 'sample_requirements_en.md';
const OPENAPI_SPEC = 'sample_openapi.yaml';
/** Requirement whose text names POST /auth/login — deterministic mock mapping. */
const TRACED_REQUIREMENT = 'REQ-001';
/** Endpoint imported from the sample spec — inventory rows carry METHOD + path. */
const TRACED_ENDPOINT = '/auth/login';
/** Demo SUT environment, mirroring demo/seed_demo.py (bearer + /api/v2 prefix). */
const SUT_ENV_NAME = 'demo-sut';

test.describe('full pipeline through the UI @e2e @regression', () => {
  test('qa_lead drives upload → confirm → import → generate → approve → run → matrix', async ({
    asQaLead,
    project,
  }) => {
    // Whole-pipeline budget: parse + generate + execute plus page compiles.
    test.setTimeout(480_000);

    const requirements = new RequirementsPage(asQaLead);
    const endpoints = new EndpointsPage(asQaLead);
    const generate = new GeneratePage(asQaLead);
    const review = new ReviewPage(asQaLead);
    const environments = new EnvironmentsPage(asQaLead);
    const runs = new RunsPage(asQaLead);
    const report = new RunReportPage(asQaLead);
    const matrix = new MatrixPage(asQaLead);

    await test.step('upload the requirements document and wait for the parse job', async () => {
      await requirements.goto(project.id);
      await expect(requirements.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

      await requirements.uploadDocument(samplePath(REQUIREMENTS_DOC));
      // The document row appears when the page's own job poll completes —
      // waiting on the badge IS waiting on the ingest job through the UI.
      await expect(requirements.parseStatusOf(REQUIREMENTS_DOC)).toHaveAttribute(
        'data-state',
        'parsed',
        { timeout: PARSE_UI_TIMEOUT_MS },
      );
    });

    await test.step('confirm all extracted requirements', async () => {
      await requirements.confirmAll();
      await expect(requirements.stateOf(TRACED_REQUIREMENT)).toHaveAttribute(
        'data-state',
        'confirmed',
      );
    });

    await test.step('import the OpenAPI spec on the endpoints page', async () => {
      await endpoints.goto(project.id);
      await expect(endpoints.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

      await endpoints.importSpecFromFile(samplePath(OPENAPI_SPEC));
      // Import is synchronous — completion surfaces as the refreshed inventory.
      await expect(endpoints.rowFor(TRACED_ENDPOINT)).toBeVisible({
        timeout: FIRST_VISIT_TIMEOUT_MS,
      });
    });

    await test.step('generate cases and wait for the job through the UI', async () => {
      await generate.goto(project.id);
      await expect(generate.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

      await generate.start(); // waits for the page's own result card (job surface)
      await expect(generate.generatedStat).toBeVisible();
    });

    await test.step('approve the generated cases on the review page', async () => {
      await review.goto(project.id);
      await expect(review.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

      // Bulk-approve every draft (≥1) so coverage on the matrix is
      // deterministic — generated titles are not known to a UI-only flow.
      await review.approveAll();
      await expect(review.stateOfFirst).toHaveAttribute('data-state', 'approved');
    });

    await test.step('create the demo SUT environment through the environments page UI', async () => {
      await environments.goto(project.id);
      await expect(environments.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

      await environments.create({
        name: SUT_ENV_NAME,
        baseUrl: `${config.sutUrl}/api/v2`,
        bearerToken: 'demo-token',
      });
      await expect(environments.cardFor(SUT_ENV_NAME)).toBeVisible();
    });

    await test.step('launch a run against the demo SUT and wait for completion', async () => {
      await runs.goto(project.id);
      await expect(runs.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

      await runs.selectEnvironmentByName(SUT_ENV_NAME);
      await runs.launch();
      // The page's own live poll refreshes the history on terminal states —
      // the row badge flipping to completed is the run's UI completion signal.
      await expect(runs.stateOfLatest).toHaveAttribute('data-state', 'completed', {
        timeout: RUN_UI_TIMEOUT_MS,
      });
    });

    await test.step('open the run report', async () => {
      await runs.openLatestRun();
      await expect(report.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });
      await expect(report.stateBadge).toHaveAttribute('data-state', 'completed');
    });

    await test.step('the matrix traces the requirement to its covering case', async () => {
      await matrix.goto(project.id);
      await expect(matrix.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

      await expect(matrix.rowFor(TRACED_REQUIREMENT)).toBeVisible();
      // Linked = at least one covering case, and a coverage status beyond
      // not_covered (covered_not_run|passing|failing|errored after the run).
      await expect(matrix.caseLinksOf(TRACED_REQUIREMENT).first()).toBeVisible();
      await expect(matrix.statusOf(TRACED_REQUIREMENT)).toHaveAttribute(
        'data-state',
        /^(covered_not_run|passing|failing|errored)$/,
      );
    });
  });
});
