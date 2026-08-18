/**
 * /projects/[id]/matrix — frontend/app/projects/[id]/matrix/page.tsx
 * (traceability matrix, BO-07). Row status badges carry data-state with the
 * coverage status vocabulary used by the page's filter pills. Composed from
 * the shared DataTable component (§4). Locators private, no assertions.
 */
import type { Locator, Page } from '@playwright/test';
import { DataTable } from '../components/data-table.component';
import { routes } from '../constants/routes';

/** Coverage statuses as exposed by the matrix filter pills. */
export type MatrixStatus = 'not_covered' | 'covered_not_run' | 'passing' | 'failing' | 'errored';

export class MatrixPage {
  constructor(private readonly page: Page) {}

  private get exportButton(): Locator {
    return this.page.getByTestId('matrix-export-button');
  }
  private get table(): DataTable {
    return new DataTable(this.page.getByTestId('matrix-table-root'));
  }
  private filterPill(status: MatrixStatus | 'all'): Locator {
    return this.page.getByTestId(`matrix-filter-${status}-pill`);
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('matrix-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('matrix-empty-state');
  }

  get coverageStat(): Locator {
    return this.page.getByTestId('matrix-coverage-stat');
  }

  get gapsStat(): Locator {
    return this.page.getByTestId('matrix-gaps-stat');
  }

  get gapCard(): Locator {
    return this.page.getByTestId('matrix-gap-card');
  }

  /**
   * Matrix row whose text contains `text` (requirement external_id or
   * description). Matrix rows are plain divs stamped with the repeated
   * `matrix-row` testid (no ARIA row role — the page does not use <table>),
   * so they are addressed via the testid, not `getByRole('row')`.
   */
  rowFor(text: string): Locator {
    return this.table.rowsByTestId('matrix-row').filter({ hasText: text }).first();
  }

  /** Coverage status badge of a row — asserted via its data-state attribute. */
  statusOf(text: string): Locator {
    return this.rowFor(text).getByTestId('matrix-row-status-badge');
  }

  /** Covering-case links of a row — rendered only when the requirement is linked (BO-07). */
  caseLinksOf(text: string): Locator {
    return this.rowFor(text).getByTestId('matrix-row-case-link');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.matrix(projectId));
  }

  async filterByStatus(status: MatrixStatus | 'all'): Promise<void> {
    await this.filterPill(status).click();
  }

  async exportMatrix(): Promise<void> {
    await this.exportButton.click();
  }

  /** Jump from a row to one of its covering cases on the review page. */
  async openCaseFrom(text: string): Promise<void> {
    await this.rowFor(text).getByTestId('matrix-row-case-link').first().click();
  }
}
