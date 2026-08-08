/**
 * Modal — models the shared Modal widget of frontend/components/ui.tsx (§3).
 * The widget renders nothing while closed (`if (!open) return null`), so
 * "closed" means detached from the DOM. Scoped to the root Locator carrying
 * the modal's data-testid (the `.modal` dialog element, not the overlay).
 * No assertions here — waiting is mechanics, verdicts belong to specs.
 */
import type { Locator } from '@playwright/test';

export class Modal {
  constructor(private readonly root: Locator) {}

  /** The dialog element itself — for visibility assertions in specs. */
  get dialog(): Locator {
    return this.root;
  }

  /** A control inside this modal, scoped so ids never leak across dialogs. */
  control(testId: string): Locator {
    return this.root.getByTestId(testId);
  }

  async waitUntilOpen(): Promise<void> {
    await this.root.waitFor({ state: 'visible' });
  }

  /** The widget unmounts on close — wait for detachment, not invisibility. */
  async waitUntilClosed(): Promise<void> {
    await this.root.waitFor({ state: 'detached' });
  }
}
