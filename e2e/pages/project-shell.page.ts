/**
 * Project shell — frontend/app/projects/[id]/layout.tsx (sidebar navigation
 * shared by every project sub-page). Owns the nav-link-* locators and the
 * mapping from a sidebar section to its page's `{domain}-page-root` testid,
 * so the navigation specs never touch Playwright directly (§1 dependency rule).
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';

/** Sidebar sections, in sidebar order (nav-link-{section} in the shell). */
export const PROJECT_SECTIONS = [
  'overview',
  'requirements',
  'runs',
  'reports',
] as const;

export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

/** {domain}-page-root domain per section — 'overview' renders dashboard-page-root. */
const ROOT_DOMAIN: Record<ProjectSection, string> = {
  overview: 'dashboard',
  requirements: 'requirements',
  runs: 'runs',
  reports: 'project-reports',
};

export class ProjectShellPage {
  constructor(private readonly page: Page) {}

  private navLink(section: ProjectSection): Locator {
    return this.page.getByTestId(`nav-link-${section}`);
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('nav-project-shell');
  }

  get sidebar(): Locator {
    return this.page.getByTestId('nav-project-sidebar');
  }

  get projectName(): Locator {
    return this.page.getByTestId('nav-project-name');
  }

  get archivedBadge(): Locator {
    return this.page.getByTestId('nav-project-archived-badge');
  }

  /** The `{domain}-page-root` element of a section's page. */
  rootOf(section: ProjectSection): Locator {
    return this.page.getByTestId(`${ROOT_DOMAIN[section]}-page-root`);
  }

  // --- actions ----------------------------------------------------------------

  /** Land on the project's overview (dashboard) — the shell's entry point. */
  async goto(projectId: string): Promise<void> {
    await this.page.goto(routes.project(projectId));
  }

  /** Navigate to a section through the sidebar, as a user would. */
  async openSection(section: ProjectSection): Promise<void> {
    await this.navLink(section).click();
  }
}
