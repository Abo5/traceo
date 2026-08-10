/**
 * A brand-new organisation with ZERO projects, plus the browser storage state
 * of its admin — the only honest way to observe the /projects empty state.
 *
 * The worker org (global/auth.setup.ts) accumulates projects from every spec
 * running in parallel, so its list is never empty. This helper registers a
 * separate org over the API (one call — identity.py returns {token, user}
 * immediately) and composes the same localStorage-based state the setup project
 * writes, so no browser login is involved (§9).
 */
import { request } from '@playwright/test';
import { storageStateFor, type OrgActor } from '../api/auth.helpers';
import { TraceoHttp } from '../api/http';
import { IdentityRepository } from '../api/identity.repository';
import { config } from '../config/resolve';
import { uniqueEmail, uniqueSuffix } from './unique';

export interface FreshOrg {
  orgName: string;
  admin: OrgActor;
  /** Playwright storageState for the admin of this org. */
  storageState: ReturnType<typeof storageStateFor>;
}

export async function registerFreshOrg(): Promise<FreshOrg> {
  const ctx = await request.newContext();
  try {
    const suffix = uniqueSuffix();
    const orgName = `e2e-fresh-${suffix}`;
    const password = `E2e-pass-${suffix}`;
    const email = uniqueEmail('fresh-admin');

    const anonymous = new IdentityRepository(new TraceoHttp(ctx, config.apiUrl));
    const session = await anonymous.register({
      org_name: orgName,
      name: 'E2E Fresh Admin',
      email,
      password,
    });

    const admin: OrgActor = {
      role: 'admin',
      email,
      password,
      token: session.token,
      user: session.user,
    };
    return { orgName, admin, storageState: storageStateFor(admin) };
  } finally {
    await ctx.dispose();
  }
}
