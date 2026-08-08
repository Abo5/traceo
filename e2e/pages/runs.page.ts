/**
 * /projects/[id]/runs — frontend/app/projects/[id]/runs/page.tsx.
 * Run state badges carry data-state="queued|running|completed|cancelled|aborted"
 * (literal Run.state values). The history table is composed from the shared
 * DataTable component (§4). Locators private, no assertions (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { DataTable } from '../components/data-table.component';
import { routes } from '../constants/routes';

export class RunsPage {
  constructor(private readonly page: Page) {}

  private get envSelect(): Locator {
    return this.page.getByTestId('runs-launch-env-select');
  }
  private get runButton(): Locator {
    return this.page.getByTestId('runs-launch-run-button');
  }
  private get cancelButton(): Locator {
    return this.page.getByTestId('runs-live-cancel-button');
  }
  private get reportButton(): Locator {
    return this.page.getByTestId('runs-live-report-button');
  }
  private get historyTable(): DataTable {
    return new DataTable(this.page.getByTestId('runs-table-root'));
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('runs-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('runs-empty-state');
  }

  get livePanel(): Locator {
    return this.page.getByTestId('runs-live-panel');
  }

  /** The launch control — renders only with trigger_run (permission-visibility checks). */
  get launchControl(): Locator {
    return this.runButton;
  }

  /** Live run badge — data-state carries the literal Run.state. */
  get liveRunState(): Locator {
    return this.page.getByTestId('runs-live-state-badge');
  }

  /** History row whose text contains `text` (e.g. the run's display id). */
  rowFor(text: string): Locator {
    return this.historyTable.rowByText(text);
  }

  /** State badge of a history row — data-state carries the literal Run.state. */
  stateOf(text: string): Locator {
    return this.rowFor(text).getByTestId('runs-row-state-badge');
  }

  /**
   * The newest history row. The history reloads through the page's own live
   * poll; in a per-test project the launched run is the only row, so "first"
   * addresses it without knowing its display id (UI-only flows).
   */
  get latestRow(): Locator {
    return this.historyTable.rowsByTestId('runs-row').first();
  }

  /** State badge of the newest history row — data-state carries the literal Run.state. */
  get stateOfLatest(): Locator {
    return this.latestRow.getByTestId('runs-row-state-badge');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.runs(projectId));
  }

  /** Pick the target environment by its option value (environment id). */
  async selectEnvironment(environmentId: string): Promise<void> {
    await this.envSelect.selectOption(environmentId);
  }

  /** Pick the target environment by its (entity-data) name — for UI-only flows. */
  async selectEnvironmentByName(name: string): Promise<void> {
    await this.envSelect.selectOption({ label: name });
  }

  /** Launch a run of all approved cases against the selected environment. */
  async launch(): Promise<void> {
    await this.runButton.click();
  }

  async cancelLiveRun(): Promise<void> {
    await this.cancelButton.click();
  }

  async openLiveReport(): Promise<void> {
    await this.reportButton.click();
  }

  async openRun(text: string): Promise<void> {
    await this.rowFor(text).getByTestId('runs-row-link').click();
  }

  /** Open the newest run's report from the history table. */
  async openLatestRun(): Promise<void> {
    await this.latestRow.getByTestId('runs-row-link').click();
  }
}
