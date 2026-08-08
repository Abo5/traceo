/**
 * /projects/[id]/endpoints — frontend/app/projects/[id]/endpoints/page.tsx.
 * Spec import is synchronous (POST /projects/{id}/api-specs — no job): the
 * page refreshes its inventory right after the call, so completion is observed
 * on the inventory rows, not on a job surface. The inventory table is composed
 * from the shared DataTable component (§4). Locators private, data-testid-first
 * (§5, §7); no assertions here.
 */
import type { Locator, Page } from '@playwright/test';
import { DataTable } from '../components/data-table.component';
import { routes } from '../constants/routes';

export class EndpointsPage {
  constructor(private readonly page: Page) {}

  private get urlTabPill(): Locator {
    return this.page.getByTestId('endpoints-import-url-pill');
  }
  private get fileTabPill(): Locator {
    return this.page.getByTestId('endpoints-import-file-pill');
  }
  private get urlInput(): Locator {
    return this.page.getByTestId('endpoints-import-url-input');
  }
  private get urlSubmitButton(): Locator {
    return this.page.getByTestId('endpoints-import-submit-button');
  }
  private get fileInput(): Locator {
    return this.page.getByTestId('endpoints-import-file-input');
  }
  private get table(): DataTable {
    return new DataTable(this.page.getByTestId('endpoints-table-root'));
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('endpoints-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('endpoints-empty-state');
  }

  get importCard(): Locator {
    return this.page.getByTestId('endpoints-import-card');
  }

  /** Inventory row whose text contains `text` (METHOD + path — entity data). */
  rowFor(text: string): Locator {
    return this.table.rowByText(text);
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.endpoints(projectId));
  }

  /**
   * Import an OpenAPI/Swagger spec from a local file: switch to the file tab
   * and feed the hidden file input directly (the visible button opens the OS
   * chooser — not automatable). Callers observe completion on the inventory.
   */
  async importSpecFromFile(filePath: string): Promise<void> {
    await this.fileTabPill.click();
    await this.fileInput.setInputFiles(filePath);
  }

  /** Import a spec by URL (the synchronous URL flavour of the same endpoint). */
  async importSpecFromUrl(url: string): Promise<void> {
    await this.urlTabPill.click();
    await this.urlInput.fill(url);
    await this.urlSubmitButton.click();
  }
}
