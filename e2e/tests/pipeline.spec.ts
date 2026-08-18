/**
 * Critical path — the pipeline is arranged over the API (generatedCase fixture:
 * upload → confirm → import spec → generate with mock LLM), then the human
 * decision is exercised through the UI: qa_lead approves the draft on the
 * review page (approve_reject = admin|qa_lead — backend/app/security.py).
 * State asserted via data-state, never via visible copy (§5, §6).
 */
import { test, expect } from '../fixtures';
import { ReviewPage } from '../pages/review.page';

test.describe('generation pipeline @critical', () => {
  test('qa_lead approves a generated draft case on the review page', async ({
    asQaLead,
    generatedCase,
  }) => {
    const review = new ReviewPage(asQaLead);
    await review.goto(generatedCase.project_id);

    await test.step('approve the draft case', async () => {
      await review.approve(generatedCase.title);
    });

    await expect(review.stateOf(generatedCase.title)).toHaveAttribute('data-state', 'approved');
  });

  test('qa_lead approves the whole draft batch with one button', async ({
    api,
    asQaLead,
    generatedCase,
  }) => {
    const review = new ReviewPage(asQaLead);
    await review.goto(generatedCase.project_id);

    await test.step('approve every draft from the header shortcut', async () => {
      await review.approveEveryDraft();
    });

    // The queue is generated, so assert on the server rather than on a sample row:
    // nothing may be left in draft, and the batch must actually have been non-empty.
    const drafts = await api.review.list(generatedCase.project_id, { state: 'draft' });
    const approved = await api.review.list(generatedCase.project_id, { state: 'approved' });
    expect(drafts).toHaveLength(0);
    expect(approved.length).toBeGreaterThan(0);
    await expect(review.approveEveryDraftControl).toBeHidden(); // nothing left to approve
  });
});
