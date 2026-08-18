/**
 * Org provisioning over the API — no browser involved (§9).
 *
 * Flow verified against backend/app/modules/identity.py:
 * 1. POST /auth/register {org_name, name, email, password} — creates the
 *    org + its admin and returns {token, user} immediately.
 * 2. POST /members/invite {email, name, role, password} (as admin) — the invite
 *    SETS the member's password directly (InviteIn.password, min 8 chars);
 *    there is no activation/confirmation step.
 * 3. POST /auth/login per role — yields each actor's own {token, user}.
 */
import { config } from '../config/resolve';
import { ROLES, type Role } from '../constants/roles';
import { uniqueEmail, uniqueSuffix } from '../helpers/unique';
import type { TraceoHttp } from './http';
import { IdentityRepository } from './identity.repository';
import type { AuthUser } from './types';

export interface OrgActor {
  role: Role;
  email: string;
  password: string;
  token: string;
  user: AuthUser;
}

export interface WorkerOrg {
  orgName: string;
  actors: OrgActor[];
}

const INVITED_ROLES: Role[] = ['qa_lead', 'qa_engineer', 'viewer'];

/** Register a fresh org and provision one actor per role. `http` must be unauthenticated. */
export async function registerWorkerOrg(http: TraceoHttp): Promise<WorkerOrg> {
  const suffix = uniqueSuffix();
  const orgName = `e2e-org-${suffix}`;
  const password = `E2e-pass-${suffix}`;

  const anonymous = new IdentityRepository(http);
  const adminEmail = uniqueEmail('admin');
  const admin = await anonymous.register({
    org_name: orgName,
    name: 'E2E Admin',
    email: adminEmail,
    password,
  });

  const asAdmin = new IdentityRepository(http.withAuth({ kind: 'bearer', token: admin.token }));
  const actors: OrgActor[] = [
    { role: 'admin', email: adminEmail, password, token: admin.token, user: admin.user },
  ];

  for (const role of INVITED_ROLES) {
    const email = uniqueEmail(role);
    await asAdmin.invite({ email, name: `E2E ${role}`, role, password });
    // the invitee's password was set by the invite — log in as them for their own token
    const session = await anonymous.login(email, password);
    actors.push({ role, email, password, token: session.token, user: session.user });
  }

  return { orgName, actors };
}

/**
 * Playwright storageState for a role — token lives in localStorage, not cookies.
 * Key names verified against frontend/lib/api.ts (traceo_token, traceo_user).
 * There is no language key: the product is English-only, so nothing pins one.
 */
export function storageStateFor(actor: OrgActor): {
  cookies: never[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
} {
  return {
    cookies: [],
    origins: [
      {
        origin: config.baseUrl,
        localStorage: [
          { name: 'traceo_token', value: actor.token },
          { name: 'traceo_user', value: JSON.stringify(actor.user) },
        ],
      },
    ],
  };
}

export function actorByRole(org: WorkerOrg, role: Role): OrgActor {
  const actor = org.actors.find((a) => a.role === role);
  if (!actor) {
    throw new Error(`No actor for role '${role}' — expected one of: ${ROLES.join(', ')}`);
  }
  return actor;
}
