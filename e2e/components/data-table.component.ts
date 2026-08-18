/**
 * DataTable — models the shared Table widget of frontend/components/ui.tsx
 * (§3, §4 Page-Component). Scoped to a root Locator (the element carrying the
 * table's data-testid, e.g. `runs-table-root`); never re-declares selectors a
 * page already owns. No assertions here — state is exposed as Locators.
 */
import type { Locator } from '@playwright/test';

export class DataTable {
  constructor(private readonly root: Locator) {}

  /** All rows (header + body) inside this table. */
  get rows(): Locator {
    return this.root.getByRole('row');
  }

  /** First row whose visible text contains `text` (entity data, not UI copy). */
  rowByText(text: string): Locator {
    return this.rows.filter({ hasText: text }).first();
  }

  /** Rows stamped with a repeated row testid (e.g. `runs-row`, `matrix-row`). */
  rowsByTestId(testId: string): Locator {
    return this.root.getByTestId(testId);
  }

  async rowCount(testId: string): Promise<number> {
    return this.rowsByTestId(testId).count();
  }
}
