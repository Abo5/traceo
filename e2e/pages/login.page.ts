/**
 * /login — frontend/app/login/page.tsx.
 * Locators are private and data-testid-first (§5, §7); actions are intent-named;
 * state is exposed as read-only Locator getters. No assertions here.
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';

export class LoginPage {
  constructor(private readonly page: Page) {}

  private get emailInput(): Locator {
    return this.page.getByTestId('login-form-email-input');
  }
  private get passwordInput(): Locator {
    return this.page.getByTestId('login-form-password-input');
  }
  private get submitButton(): Locator {
    return this.page.getByTestId('login-form-submit-button');
  }
  private get registerLink(): Locator {
    return this.page.getByTestId('login-register-link');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('login-page-root');
  }

  /** Login failure message (rendered only when a login attempt failed). */
  get errorText(): Locator {
    return this.page.getByTestId('login-form-error-text');
  }

  // --- actions ----------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto(routes.login);
  }

  /** Fill the credentials form and submit. */
  async logIn(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async goToRegister(): Promise<void> {
    await this.registerLink.click();
  }
}
