/**
 * /projects/[id]/runs/[runId] — frontend/app/projects/[id]/runs/[runId]/page.tsx
 * (run report / run detail). The header badge carries data-state with the
 * literal Run.state (queued|running|completed|cancelled|aborted). Locators
 * private, data-testid-first (§5, §7); no assertions here.
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';

export class RunReportPage {
  constructor(private readonly page: Page) {}

  private get exportButton(): Locator {
    return this.page.getByTestId('runs-report-export-button');
  }
  private tabPill(tab: 'failures' | 'all' | 'compare'): Locator {
    return this.page.getByTestId(`runs-report-tab-${tab}-pill`);
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('runs-report-page-root');
  }

  /** Run state badge — data-state carries the literal Run.state. */
  get stateBadge(): Locator {
    return this.page.getByTestId('runs-report-state-badge');
  }

  get totalStat(): Locator {
    return this.page.getByTestId('runs-report-total-stat');
  }

  get passedStat(): Locator {
    return this.page.getByTestId('runs-report-passed-stat');
  }

  get failedStat(): Locator {
    return this.page.getByTestId('runs-report-failed-stat');
  }

  get erroredStat(): Locator {
    return this.page.getByTestId('runs-report-errored-stat');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string, runId: string): Promise<void> {
    await this.page.goto(routes.run(projectId, runId));
  }

  async openTab(tab: 'failures' | 'all' | 'compare'): Promise<void> {
    await this.tabPill(tab).click();
  }

  async exportReport(): Promise<void> {
    await this.exportButton.click();
  }
}
