/**
 * /projects/[id]/requirements — frontend/app/projects/[id]/requirements/page.tsx.
 * Locators private, data-testid-first (§5, §7); state badges carry
 * data-state="extracted|confirmed|changed|removed" (literal model values).
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';
import type { RequirementState } from '../constants/states';

export class RequirementsPage {
  constructor(private readonly page: Page) {}

  private get confirmAllButton(): Locator {
    return this.page.getByTestId('requirements-toolbar-confirm-all-button');
  }
  private get uploadFileInput(): Locator {
    return this.page.getByTestId('requirements-upload-file-input');
  }
  private get searchInput(): Locator {
    return this.page.getByTestId('requirements-search-input');
  }
  private get rows(): Locator {
    return this.page.getByTestId('requirements-row');
  }
  private get documentRows(): Locator {
    return this.page.getByTestId('requirements-document-row');
  }
  private statePill(state: RequirementState | 'all'): Locator {
    return this.page.getByTestId(`requirements-filter-${state}-pill`);
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('requirements-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('requirements-empty-state');
  }

  get uploadProgress(): Locator {
    return this.page.getByTestId('requirements-upload-progress');
  }

  /** The upload dropzone — renders only with upload_documents (permission-visibility checks). */
  get uploadDropzone(): Locator {
    return this.page.getByTestId('requirements-upload-dropzone');
  }

  /** Source-document row whose text contains `filename` (entity data). */
  documentRowFor(filename: string): Locator {
    return this.documentRows.filter({ hasText: filename }).first();
  }

  /**
   * Parse-status badge of a document row — data-state carries the literal
   * SourceDocument.parse_status ("pending|parsing|parsed|failed"). The row
   * renders once the page's own ingest-job poll refreshes the document list,
   * so waiting on this badge IS waiting on the parse job through the UI.
   */
  parseStatusOf(filename: string): Locator {
    return this.documentRowFor(filename).getByTestId('requirements-document-parse-status-badge');
  }

  /** Row of the requirement whose text contains `text` (external_id or description). */
  rowFor(text: string): Locator {
    return this.rows.filter({ hasText: text }).first();
  }

  /** State badge of a requirement row — data-state carries the literal model state. */
  stateOf(text: string): Locator {
    return this.rowFor(text).getByTestId('requirements-row-state-badge');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.requirements(projectId));
  }

  /** Upload a requirements document through the dropzone's file input. */
  async uploadDocument(filePath: string): Promise<void> {
    await this.uploadFileInput.setInputFiles(filePath);
  }

  /**
   * Confirm every extracted requirement. Waits for the server round-trip
   * (POST .../requirements/confirm_all) so callers can navigate on safely.
   */
  async confirmAll(): Promise<void> {
    const confirmed = this.page.waitForResponse(
      (res) => res.url().includes('/requirements/confirm_all') && res.request().method() === 'POST',
    );
    await this.confirmAllButton.click();
    await confirmed;
  }

  /** Confirm a single requirement from its row. */
  async confirm(text: string): Promise<void> {
    await this.rowFor(text).getByTestId('requirements-row-confirm-button').click();
  }

  async filterByState(state: RequirementState | 'all'): Promise<void> {
    await this.statePill(state).click();
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query);
  }
}
