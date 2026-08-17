/**
 * /projects/[id]/target — frontend/app/projects/[id]/target/page.tsx.
 *
 * The web-target screen: a URL, a viewport, FIVE test-type checkboxes, a start
 * button that POSTs and polls the discovery job, a result card, and the DESIGN
 * SECTION — the screenshot, the extracted palette with each colour's share, and
 * the WCAG contrast findings with the passing colour `visual.nearest_accessible`
 * suggests.
 *
 * The five checkboxes are addressed by TYPE (`target-type-{type}`), never by
 * their explanatory copy: the vocabulary comes from
 * constants/states.ts WEB_TARGET_TEST_TYPES, which is the same list the 422
 * refusal must name (§5 — one vocabulary, not two).
 *
 * The page owns the 202 job: it polls and swaps progress for the result card,
 * so `start()` waits on that surface rather than on a timer (§16). Locators
 * private, no assertions here (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';
import type { WebTargetTestType } from '../constants/states';

/**
 * UI budget for a discovery started from the page — the API budget
 * (KIND_TIMEOUTS_MS.webtarget) plus the page's own polling slack. A browser
 * launch, a navigation and a screenshot sit inside it.
 */
const DISCOVERY_UI_TIMEOUT_MS = 260_000;

export class TargetPage {
  constructor(private readonly page: Page) {}

  private get startButton(): Locator {
    return this.page.getByTestId('target-start-button');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('target-page-root');
  }

  /**
   * The launcher card — URL, viewport, the five checkboxes and the start
   * button. The WHOLE card is gated on `import_spec`, so it is the unit a
   * permission assertion addresses; the list, the inventory and the design box
   * below it are `view`-level and render for every role.
   */
  get launcherCard(): Locator {
    return this.page.getByTestId('target-form-card');
  }

  get urlInput(): Locator {
    return this.page.getByTestId('target-url-input');
  }

  get viewportSelect(): Locator {
    return this.page.getByTestId('target-viewport-select');
  }

  /** The checkbox of one test type — addressed by the type, never by its copy. */
  typeCheckbox(type: WebTargetTestType): Locator {
    return this.page.getByTestId(`target-type-${type}`);
  }

  /** The start control — gated on `import_spec` (absent for a viewer). */
  get startControl(): Locator {
    return this.startButton;
  }

  get jobProgress(): Locator {
    return this.page.getByTestId('target-job-progress');
  }

  get resultCard(): Locator {
    return this.page.getByTestId('target-result-card');
  }

  // --- "Sign in first" — the authenticated crawl ------------------------------
  //
  // The credential fields are collapsed by default: discovery decides for
  // itself whether a page is a login page, so most runs need nothing typed
  // here, and a password field permanently on screen invites a real password
  // into a tool that never asked for one. The whole block is gated on
  // `import_spec` with the rest of the launcher.

  get authSection(): Locator {
    return this.page.getByTestId('target-auth-section');
  }

  /** Why nothing normally has to be filled in here. */
  get authLead(): Locator {
    return this.page.getByTestId('target-auth-lead');
  }

  /** Reveals the two credential fields — UNTICKED on first paint. */
  get authToggle(): Locator {
    return this.page.getByTestId('target-auth-toggle');
  }

  get authUsernameInput(): Locator {
    return this.page.getByTestId('target-auth-username-input');
  }

  /** MUST be `type="password"` — asserted, not assumed. */
  get authPasswordInput(): Locator {
    return this.page.getByTestId('target-auth-password-input');
  }

  /** The copy stating what the crawler will and will not do with these. */
  get authHint(): Locator {
    return this.page.getByTestId('target-auth-hint');
  }

  /** Shown while the toggle is on and either credential is blank. */
  get authIncompleteHint(): Locator {
    return this.page.getByTestId('target-auth-incomplete-hint');
  }

  /**
   * How many pages one crawl may visit (1…50 — the API's own window). OUTSIDE
   * the collapse: crawl width has nothing to do with signing in.
   */
  get maxPagesInput(): Locator {
    return this.page.getByTestId('target-max-pages-input');
  }

  /** Shown while the budget is outside 1…50 — start is disabled with it. */
  get maxPagesHint(): Locator {
    return this.page.getByTestId('target-max-pages-hint');
  }

  // --- the crawl outcome on the result card -----------------------------------

  /** `pages_visited` — rendered only when the result reports it. */
  get resultPagesVisited(): Locator {
    return this.page.getByTestId('target-result-pages-visited-stat');
  }

  /** The panel listing the pages the crawl deliberately did not open. */
  get resultPagesSkipped(): Locator {
    return this.page.getByTestId('target-result-pages-skipped');
  }

  /** One skipped page — `data-state` is the reason it was skipped. */
  get resultPageSkipRows(): Locator {
    return this.page.getByTestId('target-result-pages-skipped-row');
  }

  /** The sign-in outcome — `data-state="succeeded|failed|login_required"`. */
  get resultLogin(): Locator {
    return this.page.getByTestId('target-result-login');
  }

  /** Which proof of a successful sign-in fired. */
  get resultLoginStrategy(): Locator {
    return this.page.getByTestId('target-result-login-strategy');
  }

  /**
   * WHERE the credentials came from — `data-state="user|page"`. Provenance is
   * reportable; the values behind it are not, and never appear here.
   */
  get resultCredentialsSource(): Locator {
    return this.page.getByTestId('target-result-credentials-source');
  }

  /** Shown when a login page was found and nothing could sign in to it. */
  get resultLoginRequired(): Locator {
    return this.page.getByTestId('target-result-login-required');
  }

  /**
   * Refusal of a rejected start. `data-state` carries the API error CODE
   * (invalid_test_type, browser_discovery_unavailable …) — asserted on the
   * attribute, never on the sentence (§6).
   */
  get startError(): Locator {
    return this.page.getByTestId('target-start-error');
  }

  /** The lines the refusal attached — e.g. the legal test-type list. */
  get startErrorItems(): Locator {
    return this.page.getByTestId('target-start-error-item');
  }

  /** One stored target row — `data-state` is its discovery status. */
  get listRows(): Locator {
    return this.page.getByTestId('target-list-row');
  }

  get emptyState(): Locator {
    return this.page.getByTestId('target-empty-state');
  }

  // --- the design box ---------------------------------------------------------

  /** The design section — present on the page for every role. */
  get designSection(): Locator {
    return this.page.getByTestId('target-design-section');
  }

  /** The captured screenshot (rendered only after a successful discovery). */
  get designScreenshot(): Locator {
    return this.page.getByTestId('target-design-screenshot');
  }

  /** One palette entry — addressed by `data-colour`, never by its inline style. */
  get designPaletteSwatches(): Locator {
    return this.page.getByTestId('target-design-palette-swatch');
  }

  /** The swatch of one colour, addressed by the hex the backend reported. */
  designSwatchFor(hex: string): Locator {
    return this.page.locator(
      `[data-testid="target-design-palette-swatch"][data-colour="${hex}"]`,
    );
  }

  /** One WCAG contrast finding — `data-state="pass|fail"`, `data-fact-id` set. */
  get designContrastRows(): Locator {
    return this.page.getByTestId('target-design-contrast-row');
  }

  /** The contrast row of one design fact id (`contrast:#INK_on_#SURFACE`). */
  designContrastRowFor(factId: string): Locator {
    return this.page.locator(`[data-testid="target-design-contrast-row"][data-fact-id="${factId}"]`);
  }

  /** The suggested passing colour of a failing finding (nearest_accessible). */
  get designContrastSuggestions(): Locator {
    return this.page.getByTestId('target-design-contrast-suggestion');
  }

  /** Shown while no target is selected — the design box has nothing to show. */
  get designEmpty(): Locator {
    return this.page.getByTestId('target-design-empty');
  }

  // --- actions ----------------------------------------------------------------

  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.target(projectId));
  }

  async fillUrl(url: string): Promise<void> {
    await this.urlInput.fill(url);
  }

  async selectViewport(viewport: string): Promise<void> {
    await this.viewportSelect.selectOption(viewport);
  }

  /** Open the credentials section and type a pair into it. */
  async fillCredentials(username: string, password: string): Promise<void> {
    await this.authToggle.click();
    await this.authUsernameInput.fill(username);
    await this.authPasswordInput.fill(password);
  }

  async fillMaxPages(pages: number): Promise<void> {
    await this.maxPagesInput.fill(String(pages));
  }

  /**
   * Everything the browser is holding besides the DOM: the URL, localStorage
   * and sessionStorage. The password may appear in NONE of them — a secret in
   * a query string ends up in history, in a referrer and in a server log.
   */
  async clientSideState(): Promise<{ url: string; local: string; session: string }> {
    return {
      url: this.page.url(),
      ...(await this.page.evaluate(() => ({
        local: JSON.stringify(window.localStorage),
        session: JSON.stringify(window.sessionStorage),
      }))),
    };
  }

  /** Tick exactly the given types, clearing the two checked by default. */
  async selectTypes(
    types: readonly WebTargetTestType[],
    all: readonly WebTargetTestType[],
  ): Promise<void> {
    for (const type of all) {
      const box = this.typeCheckbox(type);
      if (types.includes(type)) await box.check();
      else await box.uncheck();
    }
  }

  /** Which types are ticked right now — the default selection is asserted on it. */
  async checkedTypes(all: readonly WebTargetTestType[]): Promise<string[]> {
    const checked: string[] = [];
    for (const type of all) {
      if (await this.typeCheckbox(type).isChecked()) checked.push(type);
    }
    return checked;
  }

  /**
   * Full intent: start the discovery and wait for the page's own result card —
   * the UI surface of the settled job.
   */
  async start(): Promise<void> {
    await this.startButton.click();
    await this.resultCard.waitFor({ state: 'visible', timeout: DISCOVERY_UI_TIMEOUT_MS });
  }
}
