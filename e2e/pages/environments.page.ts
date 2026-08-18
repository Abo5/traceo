/**
 * /projects/[id]/environments — frontend/app/projects/[id]/environments/page.tsx
 * (FR-PRJ-04/05). Create/edit share one modal (environments-form-modal),
 * composed from the shared Modal component (§4). Secrets are write-only inputs
 * that render per auth type. Locators private, no assertions (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { Modal } from '../components/modal.component';
import { routes } from '../constants/routes';

export interface EnvironmentForm {
  name: string;
  baseUrl: string;
  /**
   * Write-only bearer token (auth_type=bearer) — the demo SUT convention
   * (demo/seed_demo.py). Omit for auth_type=none.
   */
  bearerToken?: string;
}

export class EnvironmentsPage {
  constructor(private readonly page: Page) {}

  private get createButton(): Locator {
    return this.page.getByTestId('environments-create-button');
  }
  private get formModal(): Modal {
    return new Modal(this.page.getByTestId('environments-form-modal'));
  }
  private get cards(): Locator {
    return this.page.getByTestId('environments-env-card');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('environments-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('environments-empty-state');
  }

  /** The create control — renders only with manage_environments (permission-visibility checks). */
  get createControl(): Locator {
    return this.createButton;
  }

  /** Card of the environment with this (entity-data) name. */
  cardFor(name: string): Locator {
    return this.cards.filter({ hasText: name }).first();
  }

  /** Reachability-check badge of an environment card. */
  checkBadgeOf(name: string): Locator {
    return this.cardFor(name).getByTestId('environments-env-check-badge');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.environments(projectId));
  }

  /** Open the create modal, fill it, submit, and wait for the dialog to close. */
  async create(env: EnvironmentForm): Promise<void> {
    await this.createButton.click();
    const modal = this.formModal;
    await modal.waitUntilOpen();
    await modal.control('environments-name-input').fill(env.name);
    await modal.control('environments-base-url-input').fill(env.baseUrl);
    if (env.bearerToken !== undefined) {
      await modal.control('environments-auth-type-select').selectOption('bearer');
      await modal.control('environments-auth-token-input').fill(env.bearerToken);
    }
    await modal.control('environments-form-submit-button').click();
    await modal.waitUntilClosed(); // closes only after the API call succeeds
  }

  /** Trigger a reachability check from an environment's card. */
  async check(name: string): Promise<void> {
    await this.cardFor(name).getByTestId('environments-env-check-button').click();
  }
}
