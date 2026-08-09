/**
 * /projects/[id]/insights — frontend/app/projects/[id]/insights/page.tsx.
 * The sixth engine's screen (QA Insight Agent / وكيل الرؤى).
 *
 * The taxonomy is fixed: the page always renders the 9 canonical rows, each
 * repeating data-testid="insights-category-row" and carrying its canonical id
 * as mono text — so a row is addressed by that id (entity data), never by the
 * bilingual label (§5, §6). The status badge carries data-state with the
 * literal backend value (covered | gap | n_a).
 *
 * The page owns the 202 job: it polls it and swaps the progress bar for the
 * result card, so `generate()` waits on that surface, never on a timer (§16).
 * Locators private, no assertions here (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';
import type { EdgeCategory } from '../constants/states';

/** UI job budget — mirrors the API JobPoller 'generate' budget plus polling slack. */
const INSIGHT_UI_TIMEOUT_MS = 120_000;

export class InsightsPage {
  constructor(private readonly page: Page) {}

  private get categoryCheckboxes(): Locator {
    return this.page.getByTestId('insights-category-checkbox');
  }
  private get selectAllButton(): Locator {
    return this.page.getByTestId('insights-select-all-button');
  }
  private get generateButton(): Locator {
    return this.page.getByTestId('insights-generate-button');
  }
  private get toReviewButton(): Locator {
    return this.page.getByTestId('insights-to-review-button');
  }
  private get retryButton(): Locator {
    return this.page.getByTestId('insights-retry-button');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('insights-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('insights-empty-state');
  }

  /** All taxonomy rows — always the 9 canonical categories once loaded. */
  get categoryRows(): Locator {
    return this.page.getByTestId('insights-category-row');
  }

  /** The row of one category, addressed by its canonical id (never by label). */
  rowFor(category: EdgeCategory): Locator {
    return this.categoryRows.filter({ hasText: category }).first();
  }

  /** Status badge of a category row — data-state is covered | gap | n_a. */
  statusOf(category: EdgeCategory): Locator {
    return this.rowFor(category).getByTestId('insights-category-status-badge');
  }

  get totalCasesStat(): Locator {
    return this.page.getByTestId('insights-total-cases-stat');
  }

  get totalCoveredStat(): Locator {
    return this.page.getByTestId('insights-total-covered-stat');
  }

  get totalSuggestableStat(): Locator {
    return this.page.getByTestId('insights-total-suggestable-stat');
  }

  get jobProgress(): Locator {
    return this.page.getByTestId('insights-job-progress');
  }

  get resultCard(): Locator {
    return this.page.getByTestId('insights-result-card');
  }

  get createdStat(): Locator {
    return this.page.getByTestId('insights-created-stat');
  }

  get discardedStat(): Locator {
    return this.page.getByTestId('insights-discarded-stat');
  }

  /** The generate control — renders only with the `generate` capability. */
  get generateControl(): Locator {
    return this.generateButton;
  }

  /** Load-failure text of the categories card. */
  get errorText(): Locator {
    return this.page.getByTestId('insights-page-error-text');
  }

  /** Failure text of a rejected run (e.g. 422 invalid_category). */
  get generateErrorText(): Locator {
    return this.page.getByTestId('insights-generate-error-text');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.insights(projectId));
  }

  /** Tick one category. Rows with nothing to ground themselves in are disabled. */
  async selectCategory(category: EdgeCategory): Promise<void> {
    await this.rowFor(category).getByTestId('insights-category-checkbox').check();
  }

  async selectCategories(categories: readonly EdgeCategory[]): Promise<void> {
    for (const category of categories) await this.selectCategory(category);
  }

  /** Toggle every selectable (non-n_a) category through the card's own control. */
  async toggleAllSelectable(): Promise<void> {
    await this.categoryRows.first().waitFor(); // list rendered before toggling
    await this.selectAllButton.click();
  }

  /** Number of category checkboxes currently ticked. */
  async selectedCount(): Promise<number> {
    return this.categoryCheckboxes.evaluateAll(
      (nodes) => nodes.filter((n) => (n as HTMLInputElement).checked).length,
    );
  }

  /**
   * Full intent: start the deterministic run and wait for the page's own result
   * card — the UI surface of the completed builder job.
   */
  async generate(): Promise<void> {
    await this.generateButton.click();
    await this.resultCard.waitFor({ state: 'visible', timeout: INSIGHT_UI_TIMEOUT_MS });
  }

  /** Follow the result card's link into the review queue. */
  async goToReview(): Promise<void> {
    await this.toReviewButton.click();
  }

  /** Reload after a load error. */
  async retry(): Promise<void> {
    await this.retryButton.click();
  }
}
