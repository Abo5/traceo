/**
 * Permission matrix probes — derived from PERMISSIONS in backend/app/security.py:
 * approve_reject = admin|qa_lead; manage_members = admin only. Both sides are
 * proven: the UI withholds the control AND the server refuses with the uniform
 * error code `forbidden` (asserted on ApiError.code, never on message text).
 */
import { test, expect } from '../fixtures';
import { ApiError } from '../api/errors';
import { ReviewPage } from '../pages/review.page';
import { uniqueEmail } from '../helpers/unique';

test.describe('permissions @permission', () => {
  test('viewer sees no approve/reject/edit controls — and the API refuses', async ({
    api,
    asViewer,
    generatedCase,
  }) => {
    const review = new ReviewPage(asViewer);
    await review.goto(generatedCase.project_id);

    // Selecting the case into the detail pane is view-level work and proves
    // the page is hydrated and interactive — the hidden-assertions below are
    // therefore post-hydration, never vacuous. The controls conditionally
    // render on the role capability map (frontend/lib/permissions.ts): a
    // viewer's DOM simply never contains them.
    await review.select(generatedCase.title);
    await expect(review.approveControls).toBeHidden();
    await expect(review.rejectControls).toBeHidden();
    await expect(review.editControls).toBeHidden();
    await expect(review.checkboxControls).toHaveCount(0); // bulk selection is approve_reject-only
    await expect(review.stateOf(generatedCase.title)).toHaveAttribute('data-state', 'draft');

    // and the server independently refuses — both layers are proven (§12)
    const err = await api
      .as('viewer')
      .review.approve(generatedCase.id)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('forbidden');
    expect((err as ApiError).status).toBe(403);
  });

  test('qa_engineer cannot invite members (manage_members = admin only)', async ({ api }) => {
    const err = await api
      .as('qa_engineer')
      .identity.invite({
        email: uniqueEmail('forbidden-invite'),
        name: 'E2E Forbidden Invite',
        role: 'viewer',
        password: 'E2e-pass-12345',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('forbidden');
    expect((err as ApiError).status).toBe(403);
  });
});
