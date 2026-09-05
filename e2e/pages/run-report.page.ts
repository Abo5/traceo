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

  /**
   * The all-results tab is split into one section per discipline, in canonical
   * order, and a discipline the run did not produce has no section at all — an
   * empty heading would report a kind of testing as covered and clean when it
   * never ran.
   */
  get typeSections(): Locator {
    return this.page.getByTestId('runs-report-type-section');
  }

  typeSection(type: string): Locator {
    return this.page.locator(`[data-testid="runs-report-type-section"][data-type="${type}"]`);
  }

  /** The disciplines this report actually shows, in the order it shows them. */
  async listedTypes(): Promise<string[]> {
    return this.typeSections.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-type') ?? ''));
  }

  /**
   * The failures tab is split the same way, and by the same reasoning — but it
   * lists only disciplines that actually failed, so its sections are a subset of
   * the all-results ones.
   */
  get failureTypeSections(): Locator {
    return this.page.getByTestId('runs-report-failure-type-section');
  }

  failureTypeSection(type: string): Locator {
    return this.page.locator(`[data-testid="runs-report-failure-type-section"][data-type="${type}"]`);
  }

  /** Failure cards inside one discipline's section. */
  failuresOfType(type: string): Locator {
    return this.failureTypeSection(type).getByTestId('runs-report-failure-row');
  }

  /** Shown when the severity filter matches none of the run's failures. */
  get noFailuresAtSeverity(): Locator {
    return this.page.getByTestId('runs-report-no-failures-at-severity-empty');
  }

  /** Result rows inside one discipline's table. */
  rowsOfType(type: string): Locator {
    return this.typeSection(type).getByTestId('runs-report-result-row');
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
