/**
 * Per-role UI gating spot-checks (@permission @regression) — the frontend
 * defense-in-depth layer (frontend/lib/permissions.ts) hides controls the
 * server would 403. UI_PERMISSIONS below is a 1:1 transcription of that
 * module's PERMISSIONS map for the capabilities probed here (itself a
 * transcript of backend/app/security.py); if either changes, this table must
 * change with it — a drift fails loudly.
 *
 * Both directions are asserted for every role: the control is VISIBLE for each
 * granted role and ABSENT from the DOM (`toBeHidden`) for each denied role.
 * Gated controls mount only after the client resolves the role post-hydration
 * (useSyncExternalStore server snapshot = null), so every probe first settles
 * an anchor that renders for ALL roles — hidden-assertions are then honest,
 * never a vacuous pass against un-hydrated HTML. The API half of the story
 * lives in permissions-matrix.spec.ts.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { ROLES, type Role } from '../constants/roles';
import { uniqueSuffix } from '../helpers/unique';
import { projectFactory } from '../test-data/project.factory';
import { EnvironmentsPage } from '../pages/environments.page';
import { MembersPage } from '../pages/members.page';
import { ProjectsPage } from '../pages/projects.page';
import { RequirementsPage } from '../pages/requirements.page';
import { ReviewPage } from '../pages/review.page';
import { RunsPage } from '../pages/runs.page';

/**
 * Transcribed from frontend/lib/permissions.ts PERMISSIONS — only the rows a
 * check below consumes. Keys are capabilities, values the granted roles.
 */
const UI_PERMISSIONS = {
  manage_members: ['admin'],
  manage_projects: ['admin', 'qa_lead'],
  manage_environments: ['admin', 'qa_lead'],
  upload_documents: ['admin', 'qa_lead', 'qa_engineer'],
  approve_reject: ['admin', 'qa_lead'],
  trigger_run: ['admin', 'qa_lead', 'qa_engineer'],
  view_audit_log: ['admin', 'qa_lead'],
} as const satisfies Record<string, readonly Role[]>;

type UiCapability = keyof typeof UI_PERMISSIONS;

/** Shared read-only state arranged once per worker (§9) — probes never mutate it. */
interface GateContext {
  projectId: string;
  caseTitle: string;
}

interface GateCheck {
  capability: UiCapability;
  /** The gated control's testid — for the test title only. */
  control: string;
  /**
   * Navigate, settle an all-roles anchor (so the page is provably hydrated),
   * and return the gated control's locator. Assertions on the anchor live
   * here in test code — page objects stay assertion-free (§5, §7).
   */
  locate: (page: Page, ctx: GateContext) => Promise<Locator>;
}

const CHECKS: readonly GateCheck[] = [
  {
    capability: 'manage_projects',
    control: 'projects-list-create-button',
    locate: async (page) => {
      const projects = new ProjectsPage(page);
      await projects.goto();
      await expect(projects.root).toBeVisible({ timeout: 20_000 });
      return projects.createControl;
    },
  },
  {
    capability: 'approve_reject',
    control: 'review-case-approve-button',
    locate: async (page, ctx) => {
      const review = new ReviewPage(page);
      await review.goto(ctx.projectId);
      // selecting into the detail pane is view-level and requires hydration
      await review.select(ctx.caseTitle);
      return review.approveControls;
    },
  },
  {
    capability: 'upload_documents',
    control: 'requirements-upload-dropzone',
    locate: async (page, ctx) => {
      const requirements = new RequirementsPage(page);
      await requirements.goto(ctx.projectId);
      await expect(requirements.root).toBeVisible({ timeout: 20_000 });
      return requirements.uploadDropzone;
    },
  },
  {
    capability: 'trigger_run',
    control: 'runs-launch-run-button',
    locate: async (page, ctx) => {
      const runs = new RunsPage(page);
      await runs.goto(ctx.projectId);
      await expect(runs.root).toBeVisible({ timeout: 20_000 });
      return runs.launchControl;
    },
  },
  {
    capability: 'manage_environments',
    control: 'environments-create-button',
    locate: async (page, ctx) => {
      const environments = new EnvironmentsPage(page);
      await environments.goto(ctx.projectId);
      await expect(environments.root).toBeVisible({ timeout: 20_000 });
      return environments.createControl;
    },
  },
  {
    capability: 'manage_members',
    control: 'members-invite-button',
    locate: async (page) => {
      const members = new MembersPage(page);
      await members.goto();
      // role badges render for every role once GET /members resolves —
      // list is loaded and the page hydrated before the gated assertion
      await expect(members.roleBadges.first()).toBeVisible({ timeout: 20_000 });
      return members.inviteControl;
    },
  },
  {
    capability: 'view_audit_log',
    control: 'members-audit-link-button',
    locate: async (page) => {
      const members = new MembersPage(page);
      await members.goto();
      await expect(members.roleBadges.first()).toBeVisible({ timeout: 20_000 });
      return members.auditLinkControl;
    },
  },
];

test.describe('ui permission gating @permission @regression', () => {
  let ctx: GateContext;

  // Arrange once per worker as qa_lead (holds every build capability —
  // backend/app/security.py). One draft case gives the review detail pane
  // something to select; probes only read, so the state is shareable.
  test.beforeAll(async ({ api }) => {
    const lead = api.as('qa_lead');
    const project = await lead.projects.create(projectFactory());
    const requirement = await lead.ingestion.createRequirement({
      project_id: project.id,
      description: `ui-gate seed requirement ${uniqueSuffix()}`,
    });
    const draft = await lead.review.createManual(project.id, {
      title: `ui-gate draft case ${uniqueSuffix()}`,
      requirement_ids: [requirement.id],
    });
    ctx = { projectId: project.id, caseTitle: draft.title };
  });

  const runCheck = async (check: GateCheck, role: Role, page: Page): Promise<void> => {
    const control = await check.locate(page, ctx);
    if ((UI_PERMISSIONS[check.capability] as readonly Role[]).includes(role)) {
      await expect(control).toBeVisible({ timeout: 20_000 });
    } else {
      await expect(control).toBeHidden();
    }
  };

  for (const check of CHECKS) {
    const title = (role: Role): string => {
      const verdict = (UI_PERMISSIONS[check.capability] as readonly Role[]).includes(role)
        ? 'sees'
        : 'does not see';
      return `${check.capability}: ${role} ${verdict} ${check.control}`;
    };

    // Playwright resolves fixtures from the static destructuring pattern, so
    // each role binds its own fixture explicitly (ROLES stays the size guard).
    test(title('admin'), async ({ asAdmin }) => runCheck(check, 'admin', asAdmin));
    test(title('qa_lead'), async ({ asQaLead }) => runCheck(check, 'qa_lead', asQaLead));
    test(title('qa_engineer'), async ({ asQaEngineer }) => runCheck(check, 'qa_engineer', asQaEngineer));
    test(title('viewer'), async ({ asViewer }) => runCheck(check, 'viewer', asViewer));
  }

  // If backend/app/security.py ever grows a role, the explicit per-role tests
  // above must grow with it — this guard turns silent under-coverage into a failure.
  test('role coverage matches constants/roles.ts', () => {
    expect(ROLES).toEqual(['admin', 'qa_lead', 'qa_engineer', 'viewer']);
  });
});
