/**
 * /projects/[id]/review — frontend/app/projects/[id]/review/page.tsx.
 * Queue rows repeat data-testid="review-case-row" and carry data-state with the
 * literal TestCase.state; a case is addressed by its title (entity data, not
 * visible UI copy). Approve/reject act on the case selected into the detail
 * pane, so per-case actions select first and wait for the detail to catch up.
 * Locators private, no assertions (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';
import type { RejectReasonCode } from '../api/types';
import type { TestCaseState } from '../constants/states';

export class ReviewPage {
  constructor(private readonly page: Page) {}

  private get caseRows(): Locator {
    return this.page.getByTestId('review-case-row');
  }
  private get caseCheckboxes(): Locator {
    return this.page.getByTestId('review-case-checkbox');
  }
  private get detailCard(): Locator {
    return this.page.getByTestId('review-detail-card');
  }
  private get approveButton(): Locator {
    return this.page.getByTestId('review-case-approve-button');
  }
  private get rejectButton(): Locator {
    return this.page.getByTestId('review-case-reject-button');
  }
  private get rejectConfirmButton(): Locator {
    return this.page.getByTestId('review-reject-confirm-button');
  }
  private get rejectModal(): Locator {
    return this.page.getByTestId('review-reject-modal');
  }
  private get bulkBar(): Locator {
    return this.page.getByTestId('review-bulk-bar');
  }
  private get bulkApproveButton(): Locator {
    return this.page.getByTestId('review-bulk-approve-button');
  }
  private get searchInput(): Locator {
    return this.page.getByTestId('review-search-input');
  }
  private statePill(state: Exclude<TestCaseState, 'archived'> | 'all'): Locator {
    return this.page.getByTestId(`review-filter-${state}-pill`);
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('review-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('review-empty-state');
  }

  /** Queue row of the case whose title contains `title`. */
  rowFor(title: string): Locator {
    return this.caseRows.filter({ hasText: title }).first();
  }

  /** State badge of a case row — data-state carries draft|approved|rejected|stale|archived. */
  stateOf(title: string): Locator {
    return this.rowFor(title).getByTestId('review-case-state-badge');
  }

  /**
   * State badge of the first queue row — for UI-only flows that address the
   * queue positionally (generated titles are not known in advance). The row
   * order is stable across in-place state updates and reloads.
   */
  get stateOfFirst(): Locator {
    return this.caseRows.first().getByTestId('review-case-state-badge');
  }

  /** The approve control(s) of the detail pane — for permission-visibility checks. */
  get approveControls(): Locator {
    return this.approveButton;
  }

  /** The reject control of the detail pane — renders only with approve_reject. */
  get rejectControls(): Locator {
    return this.rejectButton;
  }

  /** The edit control of the detail pane — renders only with edit_test_case. */
  get editControls(): Locator {
    return this.page.getByTestId('review-case-edit-button');
  }

  /** Bulk-selection checkboxes — render only with approve_reject (they feed the bulk bar). */
  get checkboxControls(): Locator {
    return this.caseCheckboxes;
  }

  /**
   * Retry control of the page's error banner — visible only while the page is
   * showing a server error (e.g. a 403 refusal surfacing after a denied action).
   */
  get errorRetryControl(): Locator {
    return this.page.getByTestId('review-error-retry-button');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.review(projectId));
  }

  /** Select a case into the detail pane and wait until the pane shows it. */
  async select(title: string): Promise<void> {
    await this.rowFor(title).click();
    await this.detailCard.filter({ hasText: title }).waitFor();
  }

  /** Approve one case: select it, then act from the detail pane. */
  async approve(title: string): Promise<void> {
    await this.select(title);
    await this.approveButton.click();
  }

  /** Reject one case through the reject modal. */
  async reject(title: string, reason: RejectReasonCode = 'other'): Promise<void> {
    await this.select(title);
    await this.rejectButton.click();
    await this.rejectModal.waitFor({ state: 'visible' });
    await this.rejectModal.getByTestId('review-reject-reason-select').selectOption(reason);
    await this.rejectConfirmButton.click();
    await this.rejectModal.waitFor({ state: 'detached' });
  }

  /** Tick every queued case and bulk-approve; waits for the bulk bar to clear. */
  async approveAll(): Promise<void> {
    await this.caseRows.first().waitFor();
    const count = await this.caseCheckboxes.count();
    for (let i = 0; i < count; i++) {
      await this.caseCheckboxes.nth(i).check();
    }
    await this.bulkApproveButton.click();
    await this.bulkBar.waitFor({ state: 'detached' }); // selection clears after the bulk call
  }

  async filterByState(state: Exclude<TestCaseState, 'archived'> | 'all'): Promise<void> {
    await this.statePill(state).click();
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query);
  }
}
