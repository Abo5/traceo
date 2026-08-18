/**
 * Contract validation (@validation @regression) — every refusal asserted on the
 * backend's LITERAL error code (§11), verified against the module sources:
 *
 * - review.py create_test_case checks in order: missing_title →
 *   missing_requirements (BO-07 / FR-GEN-02: an unlinked case cannot exist) →
 *   invalid_type → unknown_requirements.
 * - review.py bulk_review: invalid_action → empty_ids.
 * - identity.py register: invalid_email (regex, checked before anything else);
 *   password Field(min_length=8) is pydantic, so a short password arrives as a
 *   FastAPI list detail → TraceoHttp synthesizes code 'validation_error'.
 * - projects.py create_project: ProjectCreate's name Field(min_length=1) is
 *   pydantic → 'validation_error' as well. There is no language field to
 *   validate any more (Traceo is English-only).
 */
import { test } from '../fixtures';
import type { BulkAction, NewProject, NewTestCase } from '../api/types';
import { expectApiError } from '../helpers/expect-api-error';
import { uniqueEmail, uniqueSuffix } from '../helpers/unique';

test.describe('manual test-case contract (BO-07) @validation @regression', () => {
  test('empty requirement_ids is refused with 422 missing_requirements', async ({
    api, // qa_engineer — edit_test_case suffices (security.py)
    project,
  }) => {
    await expectApiError(
      api.review.createManual(project.id, {
        title: 'e2e case without any requirement link',
        requirement_ids: [], // the BO-07 violation under test
      }),
      { status: 422, code: 'missing_requirements' },
    );
  });

  test('a whitespace-only title is refused with 422 missing_title', async ({ api, project }) => {
    await expectApiError(
      api.review.createManual(project.id, { title: '   ', requirement_ids: ['irrelevant'] }),
      { status: 422, code: 'missing_title' },
    );
  });

  test('an unknown case type is refused with 422 invalid_type', async ({ api, project }) => {
    await expectApiError(
      api.review.createManual(project.id, {
        title: 'e2e case with a bogus type',
        // type is validated BEFORE the requirement lookup (review.py), so a
        // placeholder id is enough to reach the check.
        requirement_ids: [`nonexistent-${uniqueSuffix()}`],
        type: 'destructive' as NewTestCase['type'],
      }),
      { status: 422, code: 'invalid_type' },
    );
  });

  test('requirement ids from outside the project are refused with 422 unknown_requirements', async ({
    api,
    project,
  }) => {
    await expectApiError(
      api.review.createManual(project.id, {
        title: 'e2e case pointing at a requirement that does not exist',
        requirement_ids: [`nonexistent-${uniqueSuffix()}`],
      }),
      { status: 422, code: 'unknown_requirements' },
    );
  });
});

test.describe('bulk review contract @validation @regression', () => {
  test('an unknown bulk action is refused with 422 invalid_action', async ({ api }) => {
    await expectApiError(
      // action is validated before ids (review.py bulk_review)
      api.as('qa_lead').review.bulk('archive' as BulkAction, [`case-${uniqueSuffix()}`]),
      { status: 422, code: 'invalid_action' },
    );
  });

  test('an empty ids list is refused with 422 empty_ids', async ({ api }) => {
    await expectApiError(api.as('qa_lead').review.bulk('approve', []), {
      status: 422,
      code: 'empty_ids',
    });
  });
});

test.describe('registration input contract @validation @regression', () => {
  test('a malformed email is refused with 422 invalid_email', async ({ api }) => {
    await expectApiError(
      api.identity.register({
        org_name: `e2e-val-${uniqueSuffix()}`,
        name: 'E2E Invalid Email',
        email: 'not-an-email',
        password: 'E2e-pass-12345',
      }),
      { status: 422, code: 'invalid_email' },
    );
  });

  test('a password below 8 chars is refused at the pydantic layer (422)', async ({ api }) => {
    // Field(min_length=8) rejections arrive as a FastAPI list detail — the http
    // layer maps them to the synthetic code 'validation_error' (api/http.ts).
    await expectApiError(
      api.identity.register({
        org_name: `e2e-val-${uniqueSuffix()}`,
        name: 'E2E Short Password',
        email: uniqueEmail('short-pass'),
        password: 'short',
      }),
      { status: 422, code: 'validation_error' },
    );
  });
});

test.describe('project input contract @validation @regression', () => {
  test('an empty project name is refused at the pydantic layer (422)', async ({ api }) => {
    // ProjectCreate name min_length=1 — mirrors the UI-side prevention
    // (negative.spec.ts: the create modal keeps submit disabled).
    await expectApiError(api.as('qa_lead').projects.create({ name: '' }), {
      status: 422,
      code: 'validation_error',
    });
  });

  test('an unknown automation mode is refused with 422 invalid_automation', async ({ api }) => {
    await expectApiError(
      api.as('qa_lead').projects.create({
        name: `e2e-val-${uniqueSuffix()}`,
        automation: 'semi' as NewProject['automation'],
      }),
      { status: 422, code: 'invalid_automation' },
    );
  });
});
