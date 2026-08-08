/**
 * /register — frontend/app/register/page.tsx.
 * Locators private, data-testid-first (§5, §7); no assertions here.
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';

export interface RegistrationForm {
  orgName: string;
  name: string;
  email: string;
  /** Backend requires min 8 chars (identity.py). */
  password: string;
}

export class RegisterPage {
  constructor(private readonly page: Page) {}

  private get orgNameInput(): Locator {
    return this.page.getByTestId('register-form-org-name-input');
  }
  private get nameInput(): Locator {
    return this.page.getByTestId('register-form-name-input');
  }
  private get emailInput(): Locator {
    return this.page.getByTestId('register-form-email-input');
  }
  private get passwordInput(): Locator {
    return this.page.getByTestId('register-form-password-input');
  }
  private get submitButton(): Locator {
    return this.page.getByTestId('register-form-submit-button');
  }
  private get loginLink(): Locator {
    return this.page.getByTestId('register-login-link');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('register-page-root');
  }

  get errorText(): Locator {
    return this.page.getByTestId('register-form-error-text');
  }

  // --- actions ----------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto(routes.register);
  }

  /** Fill the registration form and submit — creates org + admin (409 email_taken on reuse). */
  async register(form: RegistrationForm): Promise<void> {
    await this.orgNameInput.fill(form.orgName);
    await this.nameInput.fill(form.name);
    await this.emailInput.fill(form.email);
    await this.passwordInput.fill(form.password);
    await this.submitButton.click();
  }

  async goToLogin(): Promise<void> {
    await this.loginLink.click();
  }
}
