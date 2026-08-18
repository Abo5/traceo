/**
 * /projects/[id]/runs — frontend/app/projects/[id]/runs/page.tsx.
 *
 * The page is the whole testing process: a wizard that takes an app URL, an
 * optional requirements document and a set of test types, scans the app, runs
 * what it built, and lists the failures with a fix prompt each. Below it sits
 * the run history.
 *
 * The older "run approved cases against an environment" launcher is gone with
 * the Environments and Review pages, so the environment picker, subset modal and
 * live-run panel locators went with it. Run state badges still carry
 * data-state="queued|running|completed|cancelled|aborted" (literal Run.state
 * values) and the history is the shared DataTable component (§4). Locators
 * private, no assertions (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { DataTable } from '../components/data-table.component';
import { routes } from '../constants/routes';

export class RunsPage {
  constructor(private readonly page: Page) {}

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

  /** The wizard card — the only way to start a run. */
  get wizard(): Locator {
    return this.page.getByTestId('runs-pipeline-card');
  }

  /** Start control — renders only with trigger_run (permission-visibility checks). */
  get pipelineStartControl(): Locator {
    return this.page.getByTestId('runs-pipeline-start-button');
  }

  get urlField(): Locator {
    return this.page.getByTestId('runs-pipeline-url-input');
  }

  /** Optional BRD/TRD picker — a run without one tests the page's own claims. */
  get documentInput(): Locator {
    return this.page.getByTestId('runs-pipeline-doc-input');
  }

  /** One card per test type: functional | ui | api | performance | security. */
  testType(type: string): Locator {
    return this.page.getByTestId(`runs-pipeline-type-${type}`);
  }

  /** Live progress card, shown only while the run is in flight. */
  get progress(): Locator {
    return this.page.getByTestId('runs-pipeline-progress');
  }

  /** The verdict card the run leaves behind. */
  get result(): Locator {
    return this.page.getByTestId('runs-pipeline-result-card');
  }

  /** One card per failure, each carrying its fix prompt. */
  get failures(): Locator {
    return this.page.getByTestId('runs-pipeline-failure-card');
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
   * The newest history row. In a per-test project the run just started is the
   * only row, so "first" addresses it without knowing its display id.
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

  async fillUrl(url: string): Promise<void> {
    await this.urlField.fill(url);
  }

  async toggleTestType(type: string): Promise<void> {
    await this.testType(type).click();
  }

  /** Start the run: scan the app, build cases from it, execute them. */
  async start(): Promise<void> {
    await this.pipelineStartControl.click();
  }

  async openRun(text: string): Promise<void> {
    await this.rowFor(text).getByTestId('runs-row-link').click();
  }

  /** Open the newest run's report from the history table. */
  async openLatestRun(): Promise<void> {
    await this.latestRow.getByTestId('runs-row-link').click();
  }
}
