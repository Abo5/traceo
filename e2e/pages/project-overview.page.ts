/**
 * /projects/[id] — frontend/app/projects/[id]/page.tsx (project overview /
 * dashboard, FR-PRJ-07). Locators private, data-testid-first (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';

export class ProjectOverviewPage {
  constructor(private readonly page: Page) {}

  private get quickGenerateButton(): Locator {
    return this.page.getByTestId('dashboard-quick-generate-button');
  }
  private get quickReviewButton(): Locator {
    return this.page.getByTestId('dashboard-quick-review-button');
  }
  private get quickRunButton(): Locator {
    return this.page.getByTestId('dashboard-quick-run-button');
  }
  private get retryButton(): Locator {
    return this.page.getByTestId('dashboard-retry-button');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('dashboard-page-root');
  }

  get coverageStat(): Locator {
    return this.page.getByTestId('dashboard-coverage-stat');
  }

  get approvedCasesStat(): Locator {
    return this.page.getByTestId('dashboard-approved-cases-stat');
  }

  /** Latest run badge — data-state carries queued|running|completed|cancelled|aborted. */
  get latestRunState(): Locator {
    return this.page.getByTestId('dashboard-latest-run-state-badge');
  }

  /** Case-state distribution chip, e.g. stateChip('approved'). */
  stateChip(state: 'draft' | 'approved' | 'rejected' | 'stale' | 'archived'): Locator {
    return this.page.getByTestId(`dashboard-case-state-${state}-chip`);
  }

  get errorText(): Locator {
    return this.page.getByTestId('dashboard-error-text');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.project(projectId));
  }

  async quickGenerate(): Promise<void> {
    await this.quickGenerateButton.click();
  }

  async quickReview(): Promise<void> {
    await this.quickReviewButton.click();
  }

  async quickRun(): Promise<void> {
    await this.quickRunButton.click();
  }

  async retry(): Promise<void> {
    await this.retryButton.click();
  }
}
