/**
 * /landing — frontend/app/landing/page.tsx.
 *
 * The public page: a WebGL hero the visitor can spin and scan, four scroll acts
 * that drive the scene, and a defect the visitor repairs to be handed the same
 * fix prompt the product emits.
 *
 * The canvas publishes `data-ready="1"` on its host once three has loaded and
 * the scene has been constructed, which is the only honest signal that the
 * animation is running — a visible <canvas> proves nothing, since an element
 * with a dead WebGL context looks identical to a live one.
 *
 * Locators private, no assertions (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';

export class LandingPage {
  constructor(private readonly page: Page) {}

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('landing-root');
  }

  get hero(): Locator {
    return this.page.getByTestId('landing-hero');
  }

  /** The scene host. `data-ready` flips to "1" when the scene is live. */
  get canvas(): Locator {
    return this.page.getByTestId('landing-canvas');
  }

  /** One per act of the explanation: 1 look, 2 generate, 3 run, 4 fix. */
  act(n: 1 | 2 | 3 | 4): Locator {
    return this.page.getByTestId(`landing-act-${n}`);
  }

  /** How many defects are left on the model, with the repair control. */
  get bugBar(): Locator {
    return this.page.getByTestId('landing-bug-bar');
  }

  get fixAllControl(): Locator {
    return this.page.getByTestId('landing-fix-all');
  }

  /** The prompt a repaired defect leaves behind, inside the act card. */
  get fixPrompt(): Locator {
    return this.page.getByTestId('landing-fix-prompt');
  }

  get appCallToAction(): Locator {
    return this.page.getByTestId('landing-cta-app');
  }

  /**
   * The sign-in at the foot of the page. The model is the frame around it, but
   * these are real inputs against the real endpoint — a painted rectangle
   * cannot be focused, autofilled, or read out by a screen reader.
   */
  get signIn(): Locator {
    return this.page.getByTestId('landing-signin');
  }

  get signInEmail(): Locator {
    return this.page.getByTestId('landing-signin-email');
  }

  get signInPassword(): Locator {
    return this.page.getByTestId('landing-signin-password');
  }

  get signInSubmit(): Locator {
    return this.page.getByTestId('landing-signin-submit');
  }

  /** Whatever the server said, shown verbatim rather than as "something went wrong". */
  get signInError(): Locator {
    return this.page.getByTestId('landing-signin-error');
  }

  get features(): Locator {
    return this.page.getByTestId('landing-features');
  }

  // --- actions ----------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto(routes.landing);
  }

  /** Wait for the scene to be constructed, not merely for a canvas to exist. */
  async waitForScene(timeout = 30_000): Promise<void> {
    await this.page.waitForFunction(
      () => document.querySelector('[data-testid=landing-canvas]')?.getAttribute('data-ready') === '1',
      undefined,
      { timeout },
    );
  }

  async openAct(n: 1 | 2 | 3 | 4): Promise<void> {
    await this.act(n).scrollIntoViewIfNeeded();
  }

  async signInWith(email: string, password: string): Promise<void> {
    await this.signInEmail.fill(email);
    await this.signInPassword.fill(password);
    await this.signInSubmit.click();
  }

  async fixEveryDefect(): Promise<void> {
    await this.fixAllControl.click();
  }
}
