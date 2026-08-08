/**
 * /projects/[id]/generate — frontend/app/projects/[id]/generate/page.tsx.
 * The page itself polls the 202 generate job through its own UI (progress bar
 * then result card) — `start()` waits on that surface, never on timers (§16).
 * Locators private, data-testid-first (§5, §7); no assertions here.
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';
import type { GenerationDepth } from '../api/types';

/** UI job budget — mirrors the API JobPoller 'generate' budget plus polling slack. */
const GENERATE_UI_TIMEOUT_MS = 120_000;

export class GeneratePage {
  constructor(private readonly page: Page) {}

  private get selectAllButton(): Locator {
    return this.page.getByTestId('generate-select-all-button');
  }
  private get requirementRows(): Locator {
    return this.page.getByTestId('generate-requirement-row');
  }
  private get requirementCheckboxes(): Locator {
    return this.page.getByTestId('generate-requirement-checkbox');
  }
  private depthButton(depth: GenerationDepth): Locator {
    return this.page.getByTestId(`generate-depth-${depth}-button`);
  }
  private get submitButton(): Locator {
    return this.page.getByTestId('generate-submit-button');
  }
  private get toReviewButton(): Locator {
    return this.page.getByTestId('generate-to-review-button');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('generate-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('generate-empty-state');
  }

  get jobProgress(): Locator {
    return this.page.getByTestId('generate-job-progress');
  }

  get resultCard(): Locator {
    return this.page.getByTestId('generate-result-card');
  }

  get generatedStat(): Locator {
    return this.page.getByTestId('generate-generated-stat');
  }

  get discardedStat(): Locator {
    return this.page.getByTestId('generate-discarded-stat');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.generate(projectId));
  }

  /** Tick every confirmed requirement currently listed. */
  async selectAllRequirements(): Promise<void> {
    await this.requirementRows.first().waitFor(); // list rendered before toggling
    await this.selectAllButton.click();
  }

  async chooseDepth(depth: GenerationDepth): Promise<void> {
    await this.depthButton(depth).click();
  }

  /**
   * Full intent: select all requirements, pick the depth, submit, and wait for
   * the page's own result card — the UI surface of the completed generate job.
   */
  async start(depth: GenerationDepth = 'standard'): Promise<void> {
    await this.selectAllRequirements();
    await this.chooseDepth(depth);
    await this.submitButton.click();
    await this.resultCard.waitFor({ state: 'visible', timeout: GENERATE_UI_TIMEOUT_MS });
  }

  /** Number of requirement checkboxes currently ticked. */
  async selectedCount(): Promise<number> {
    return this.requirementCheckboxes.evaluateAll(
      (nodes) => nodes.filter((n) => (n as HTMLInputElement).checked).length,
    );
  }

  async goToReview(): Promise<void> {
    await this.toReviewButton.click();
  }
}
