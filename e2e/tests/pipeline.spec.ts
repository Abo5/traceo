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
});
