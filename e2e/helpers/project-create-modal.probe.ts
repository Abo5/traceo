/**
 * Probe for the /projects create dialog — exposes the raw controls that
 * ProjectsPage.createProject() intentionally hides behind its happy path, so
 * negative specs can assert the PREVENTED submit: an empty/whitespace name
 * keeps the button disabled (frontend/app/projects/page.tsx:
 * `disabled={creating || !form.name.trim()}`). Locators only, data-testid-first
 * (§5/§7) — no assertions here.
 */
import type { Locator, Page } from '@playwright/test';
import { Modal } from '../components/modal.component';

export class ProjectCreateModalProbe {
  constructor(private readonly page: Page) {}

  private get modal(): Modal {
    return new Modal(this.page.getByTestId('projects-create-modal'));
  }

  /** The dialog element — visible while the modal is open (unmounts on close). */
  get dialog(): Locator {
    return this.modal.dialog;
  }

  get nameInput(): Locator {
    return this.modal.control('projects-create-name-input');
  }

  get submitButton(): Locator {
    return this.modal.control('projects-create-submit-button');
  }

  async open(): Promise<void> {
    await this.page.getByTestId('projects-list-create-button').click();
    await this.modal.waitUntilOpen();
  }
}
