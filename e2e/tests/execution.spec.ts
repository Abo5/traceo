/**
 * Execution — path-parameter binding (@critical @regression).
 *
 * The regression this spec exists for, reported from production usage: a run
 * against a templated endpoint sent the TEMPLATE, not a value —
 *   GET https://host/calendars/%7BcalendarId%7D/events?calendarId=example
 * so every path-parameterised case 404'd no matter what the system under test
 * did, and the value that should have filled the placeholder was sent as a
 * query parameter instead.
 *
 * Why an outcome assertion cannot catch this: a 404 is a perfectly ordinary
 * test result. The only place a run states what it actually requested is the
 * recorded evidence URL (execution.py `req_evidence.url`, typed as
 * `EvidenceRequest` in api/types.ts), so that is what is asserted here — first
 * as a blanket ban on template debris, then precisely, against the value the
 * step itself carries.
 *
 * The contract being pinned (backend/app/modules/execution.py
 * `_bind_path_params`, mirrored by the Go port):
 *   1. `{name}` is taken from the step's params when present and non-null,
 *      else from the run context (environment variables), else left literal.
 *   2. The key a placeholder consumed is REMOVED from the query params, so the
 *      value is never sent twice.
 *   3. Values are percent-encoded.
 * (1) and (2) are asserted below; (3) is asserted implicitly — the helper
 * compares DECODED segments, so an unencoded value that broke the path into
 * extra segments would fail the match.
 *
 * Arrangement is the shared `generatedCase` fixture (upload → confirm → import
 * the OpenAPI sample → generate), because the sample declares three templated
 * paths — `/customers/{id}`, `/orders/{id}/cancel`, `/invoices/{id}` — and
 * three requirements (REQ-007/010/011) that name them. Only the cases that
 * actually hit one are approved and run, so the execute job stays small.
 */
import { test, expect } from '../fixtures';
import { config } from '../config/resolve';
import { evidenceForStep, evidenceUrls } from '../api/execution.repository';
import type { TestCase, TestStep } from '../api/types';
import {
  boundPathValues,
  isTemplatedPath,
  pathOf,
  pathParamNames,
  queryKeysOf,
  templateMarkersIn,
} from '../helpers/path-params';
import { uniqueSuffix } from '../helpers/unique';

/** Demo SUT (:9000) — bearer + the /api/v2 prefix, mirroring demo/seed_demo.py. */
const SUT_BASE_PATH = '/api/v2';
const SUT_TOKEN = 'demo-token';

/** Enough to cover several distinct templated endpoints, few enough to stay quick. */
const MAX_CASES_UNDER_TEST = 6;

/** Steps whose path carries a `{name}` placeholder, with their index in the case. */
function templatedSteps(testCase: TestCase): Array<{ index: number; step: TestStep }> {
  return (testCase.steps ?? [])
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => isTemplatedPath(step.path));
}

/** The step's own request params — where the binder looks first. */
function stepParams(step: TestStep): Record<string, unknown> {
  const params = (step.request as { params?: unknown } | undefined)?.params;
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

test.describe('execution — path parameters @critical @regression', () => {
  test('a run binds {placeholders} to real values and never sends the template', async ({
    api,
    generatedCase, // upload → confirm → import → generate, on its own project
  }) => {
    // The fixture chain (parse + generate) plus an execute job against :9000.
    test.setTimeout(480_000);

    const lead = api.as('qa_lead'); // approve_reject + manage_environments
    const projectId = generatedCase.project_id;

    // --- arrangement guards: the assertion must not be able to pass vacuously ---

    const endpoints = await lead.discovery.listEndpoints(projectId);
    const templatedEndpoints = endpoints.filter((endpoint) => isTemplatedPath(endpoint.path));
    expect(
      templatedEndpoints.map((endpoint) => endpoint.path),
      'the imported inventory carries no templated path — nothing to bind',
    ).not.toHaveLength(0);

    const drafts = await lead.review.list(projectId, { state: 'draft' });
    const details = await Promise.all(drafts.map((draft) => lead.review.get(draft.id)));
    const casesUnderTest = details
      .filter((testCase) => templatedSteps(testCase).length > 0)
      .slice(0, MAX_CASES_UNDER_TEST);
    expect(
      casesUnderTest.length,
      'generation produced no case whose step targets a templated path',
    ).toBeGreaterThan(0);

    // The binder's first source is the step's params: if the value did not live
    // there, this spec would be proving something else entirely.
    for (const testCase of casesUnderTest) {
      for (const { step } of templatedSteps(testCase)) {
        for (const name of pathParamNames(step.path)) {
          expect(
            stepParams(step)[name],
            `case ${testCase.id} step ${step.path} carries no value for {${name}}`,
          ).not.toBeUndefined();
        }
      }
    }

    // --- act: approve just those cases and run them against the demo SUT -------

    const ids = casesUnderTest.map((testCase) => testCase.id);
    const approved = await lead.review.bulk('approve', ids);
    expect(approved.processed).toBe(ids.length);

    const environment = await lead.projects.createEnvironment(projectId, {
      name: `e2e-sut-${uniqueSuffix()}`,
      base_url: `${config.sutUrl}${SUT_BASE_PATH}`,
      auth_type: 'bearer',
      auth_config: { token: SUT_TOKEN },
    });

    const run = await lead.runs.createAndWait(projectId, {
      environment_id: environment.id,
      test_case_ids: ids,
    });
    expect(run.state).toBe('completed');

    const results = await lead.runs.results(run.id);
    expect(results).toHaveLength(ids.length);

    // --- assert 1: no recorded URL carries template debris, bound or not ------
    // Outcomes are deliberately NOT asserted: the demo SUT answers 404 for an
    // unknown id, which is a legitimate result. What may never happen is the
    // request going out as a template.

    const urls = results.flatMap(evidenceUrls);
    expect(urls.length, 'the run recorded no evidence at all').toBeGreaterThan(0);
    for (const url of urls) {
      expect(
        templateMarkersIn(pathOf(url)),
        `evidence URL still carries an unbound template: ${url}`,
      ).toHaveLength(0);
    }

    // --- assert 2: each placeholder resolved to the step's own value, once ----

    let placeholdersVerified = 0;
    for (const testCase of casesUnderTest) {
      const result = results.find((candidate) => candidate.test_case.id === testCase.id);
      expect(result, `the run produced no result for case ${testCase.id}`).toBeDefined();
      if (!result) continue;

      for (const { index, step } of templatedSteps(testCase)) {
        const evidence = evidenceForStep(result, index);
        if (!evidence) continue; // the case halted on an earlier step — nothing recorded here

        const url = evidence.request.url;
        const bound = boundPathValues(step.path, url);
        const params = stepParams(step);

        for (const name of pathParamNames(step.path)) {
          expect(
            bound[name],
            `{${name}} of ${step.method} ${step.path} was not bound to the step's value in ${url}`,
          ).toBe(String(params[name]));

          // The consumed key must not ALSO travel as a query parameter — that
          // second half of the symptom (`?calendarId=example`) is a defect on
          // its own: it can change how the system under test answers.
          expect(
            queryKeysOf(url),
            `{${name}} was bound but ${name} was still sent as a query parameter in ${url}`,
          ).not.toContain(name);

          placeholdersVerified += 1;
        }
      }
    }

    expect(
      placeholdersVerified,
      'no placeholder was actually verified — every case halted before its templated step',
    ).toBeGreaterThan(0);
  });
});
