/**
 * GenerationJourney — the reference multi-page business flow (§3): confirm the
 * extracted requirements, generate endpoint-grounded cases, approve them all.
 * It is the UI counterpart of backend/tests/test_flow.py's pipeline segment.
 *
 * A journey orchestrates pages under one intent-named verb. It asserts no
 * business outcomes (the spec's job) and carries no locators (§1 dependency
 * rule) — each page waits through its own surface (job progress, bulk bar).
 */
import type { GenerationDepth } from '../api/types';
import type { GeneratePage } from '../pages/generate.page';
import type { RequirementsPage } from '../pages/requirements.page';
import type { ReviewPage } from '../pages/review.page';

export class GenerationJourney {
  constructor(
    private readonly reqs: RequirementsPage,
    private readonly gen: GeneratePage,
    private readonly review: ReviewPage,
  ) {}

  /** Confirm all requirements → generate (page waits its own job) → approve all drafts. */
  async generateAndApproveAll(projectId: string, depth: GenerationDepth = 'standard'): Promise<void> {
    await this.reqs.goto(projectId);
    await this.reqs.confirmAll();
    await this.gen.goto(projectId);
    await this.gen.start(depth);
    await this.review.goto(projectId);
    await this.review.approveAll();
  }

  /** Same flow but stop at review — leaves the generated cases as drafts. */
  async generateDrafts(projectId: string, depth: GenerationDepth = 'standard'): Promise<void> {
    await this.reqs.goto(projectId);
    await this.reqs.confirmAll();
    await this.gen.goto(projectId);
    await this.gen.start(depth);
  }
}
