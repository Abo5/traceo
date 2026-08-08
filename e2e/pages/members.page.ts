/**
 * /settings/members — frontend/app/settings/members/page.tsx. The member table
 * (GET /members) renders for every role (view-level); invite / role-select /
 * remove are gated behind manage_members and the audit link behind
 * view_audit_log (frontend/lib/permissions.ts). Locators private where they
 * back actions, read-only getters for permission-visibility checks — no
 * assertions here (§5, §7).
 */
import type { Locator, Page } from '@playwright/test';
import { routes } from '../constants/routes';

export class MembersPage {
  constructor(private readonly page: Page) {}

  private get rows(): Locator {
    return this.page.getByTestId('members-row');
  }

  // --- state (read-only) ------------------------------------------------------

  get root(): Locator {
    return this.page.getByTestId('members-page-root');
  }

  /**
   * Role badges of the member rows — rendered for every role once the member
   * list has loaded, so `roleBadges.first()` doubles as a post-hydration anchor
   * for visibility checks on the gated controls below.
   */
  get roleBadges(): Locator {
    return this.rows.getByTestId('members-row-role-badge');
  }

  /** Invite control — renders only with manage_members. */
  get inviteControl(): Locator {
    return this.page.getByTestId('members-invite-button');
  }

  /** Audit-log link — renders only with view_audit_log. */
  get auditLinkControl(): Locator {
    return this.page.getByTestId('members-audit-link-button');
  }

  /** Per-row role selects — render only with manage_members. */
  get roleSelectControls(): Locator {
    return this.page.getByTestId('members-row-role-select');
  }

  // --- actions ----------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto(routes.settingsMembers);
  }
}
