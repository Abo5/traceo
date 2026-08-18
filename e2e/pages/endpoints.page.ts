/**
 * /projects/[id]/endpoints — frontend/app/projects/[id]/endpoints/page.tsx.
 * Import is synchronous (POST /projects/{id}/api-specs — no job): the page
 * refreshes its inventory right after the call, so completion is observed on
 * the inventory rows, not on a job surface. The inventory table is composed
 * from the shared DataTable component (§4). Locators private, data-testid-first
 * (§5, §7); no assertions here.
 *
 * The same import card takes an OpenAPI/Swagger spec AND a Postman collection,
 * a HAR capture or an Insomnia export — the server detects the format and
 * echoes it, so the page gained a format badge, the two enrichment counters and
 * the three nullable AI columns. All of them are read-only surfaces here.
 *
 * A successful import into a project that had NO environment also derives one
 * from the document; the page confirms that with a line naming it, which is the
 * last read-only surface below.
 */
import type { Locator, Page } from '@playwright/test';
import { DataTable } from '../components/data-table.component';
import { routes } from '../constants/routes';
import type { SpecFormat } from '../constants/states';

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

  /** Every inventory row currently rendered. */
  get rows(): Locator {
    return this.table.rowsByTestId('endpoints-row');
  }

  /** Inventory row whose text contains `text` (METHOD + path — entity data). */
  rowFor(text: string): Locator {
    return this.table.rowByText(text);
  }

  /** The detected-format badge of the last import (any format). */
  get formatBadge(): Locator {
    return this.page.getByTestId('endpoints-import-format-badge');
  }

  /**
   * The format badge, carrying the given detected format.
   *
   * The badge PRINTS a human label ("Postman Collection v2") and carries the
   * vocabulary value on `data-format` (mirrored on `data-state`). The assertion
   * therefore reads the attribute, never the label — copy is product wording
   * and changes freely, a format id does not (§5, §6).
   */
  formatBadgeFor(format: SpecFormat): Locator {
    return this.page.locator(
      `[data-testid="endpoints-import-format-badge"][data-format="${format}"]`,
    );
  }

  /** AI enrichment counters of the last import — rendered only when reported. */
  get enrichedBadge(): Locator {
    return this.page.getByTestId('endpoints-import-enriched-badge');
  }

  get enrichmentDiscardedBadge(): Locator {
    return this.page.getByTestId('endpoints-import-enrichment-discarded-badge');
  }

  // --- derived environment (rendered only when the import created one) ---------

  /**
   * The confirmation line for the environment the import derived from the
   * document — its name and base URL. Absent whenever `environment_created` is
   * null (the project already had an environment, or no base URL was derivable),
   * which is a legitimate state rather than a defect.
   */
  get importEnvironmentCreated(): Locator {
    return this.page.getByTestId('endpoints-import-environment-created');
  }

  /** The link out of that line to the project's environments page. */
  get importEnvironmentCreatedLink(): Locator {
    return this.page.getByTestId('endpoints-import-environment-created-link');
  }

  // --- refusal surface (422 invalid_spec) --------------------------------------

  get importError(): Locator {
    return this.page.getByTestId('endpoints-import-error');
  }

  /** The `errors` list of the refusal — the part that names the supported formats. */
  get importErrorItems(): Locator {
    return this.page.getByTestId('endpoints-import-error-item');
  }

  // --- AI enrichment columns (nullable — rendered only where present) ----------

  get aiGroupCells(): Locator {
    return this.page.getByTestId('endpoints-row-ai-group');
  }

  get aiCriticalityCells(): Locator {
    return this.page.getByTestId('endpoints-row-ai-criticality');
  }

  get aiDescriptionCells(): Locator {
    return this.page.getByTestId('endpoints-row-ai-description');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.endpoints(projectId));
  }

  /**
   * Import an API document from a local file: switch to the file tab and feed
   * the hidden file input directly (the visible button opens the OS chooser —
   * not automatable). Callers observe completion on the inventory.
   *
   * Format-agnostic: an OpenAPI spec, a Postman collection, a HAR capture and
   * an Insomnia export all travel through this one control.
   */
  async importSpecFromFile(filePath: string): Promise<void> {
    await this.fileTabPill.click();
    await this.fileInput.setInputFiles(filePath);
  }

  /** Import by URL (the synchronous URL flavour of the same endpoint). */
  async importSpecFromUrl(url: string): Promise<void> {
    await this.urlTabPill.click();
    await this.urlInput.fill(url);
    await this.urlSubmitButton.click();
  }
}
