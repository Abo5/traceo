/**
 * /projects — frontend/app/projects/page.tsx (project list + create modal).
 * Locators private, data-testid-first (§5, §7); the create dialog is composed
 * from the shared Modal component (§4 Page-Component). No assertions here.
 */
import type { Locator, Page } from '@playwright/test';
import { Modal } from '../components/modal.component';
import { routes } from '../constants/routes';
import type { NewProject } from '../api/types';

export class ProjectsPage {
  constructor(private readonly page: Page) {}

  private get createButton(): Locator {
    return this.page.getByTestId('projects-list-create-button');
  }
  /** Empty-state call to action — opens the SAME create modal as the header button. */
  private get emptyCreateButton(): Locator {
    return this.page.getByTestId('projects-empty-create-button');
  }
  private get createModal(): Modal {
    return new Modal(this.page.getByTestId('projects-create-modal'));
  }
  private get cards(): Locator {
    return this.page.getByTestId('projects-list-card');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('projects-page-root');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('projects-empty-state');
  }

  get errorText(): Locator {
    return this.page.getByTestId('projects-page-error-text');
  }

  /** The header create control — renders only with manage_projects (permission-visibility checks). */
  get createControl(): Locator {
    return this.createButton;
  }

  /** The empty-state create control — same permission gate, only shown with no projects. */
  get emptyCreateControl(): Locator {
    return this.emptyCreateButton;
  }

  /** The create dialog itself — open after either entry point is clicked. */
  get createDialog(): Locator {
    return this.page.getByTestId('projects-create-modal');
  }

  get createErrorText(): Locator {
    return this.page.getByTestId('projects-create-error-text');
  }

  /** The list card of the project with this (entity-data) name. */
  cardFor(name: string): Locator {
    return this.cards.filter({ hasText: name }).first();
  }

  /** Status badge of a project card — carries data-state="active|archived". */
  statusOf(name: string): Locator {
    return this.cardFor(name).getByTestId('projects-card-status-badge');
  }

  // --- actions ----------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto(routes.projects);
  }

  /** Open the create modal from the page header. */
  async openCreateModal(): Promise<void> {
    await this.createButton.click();
    await this.createModal.waitUntilOpen();
  }

  /** Open the create modal from the empty-state call to action. */
  async openCreateModalFromEmptyState(): Promise<void> {
    await this.emptyCreateButton.click();
    await this.createModal.waitUntilOpen();
  }

  /**
   * Open the create modal, fill it, submit, and wait for the dialog to close.
   * Name is the whole form: automation defaults to "auto" server-side and there
   * is no project language (Traceo is English-only).
   */
  async createProject(project: NewProject): Promise<void> {
    await this.openCreateModal();
    await this.submitCreateForm(project.name);
  }

  /** Fill and submit the already-open create dialog. */
  async submitCreateForm(name: string): Promise<void> {
    const modal = this.createModal;
    await modal.control('projects-create-name-input').fill(name);
    await modal.control('projects-create-submit-button').click();
    await modal.waitUntilClosed(); // closes only after the API call succeeds
  }

  /** Open a project by name — lands on its overview (dashboard). */
  async openProject(name: string): Promise<void> {
    await this.cardFor(name).getByTestId('projects-card-open-button').click();
  }
}
