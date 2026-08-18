/**
 * Second-tenant provisioning for isolation probes (NFR-SEC-04) — registers a
 * brand-new organisation whose admin holds NO membership in the worker org.
 * Mirrors api/auth.helpers.ts registerWorkerOrg but stays deliberately small:
 * one admin actor is enough to prove that cross-org reads answer 404, not 403.
 */
import { request } from '@playwright/test';
import { TraceoHttp } from '../api/http';
import { IdentityRepository } from '../api/identity.repository';
import { ProjectsRepository } from '../api/projects.repository';
import { ReviewRepository } from '../api/review.repository';
import { config } from '../config/resolve';
import { uniqueEmail, uniqueSuffix } from './unique';

export interface ForeignOrg {
  orgName: string;
  /** Repositories authenticated as the foreign org's admin. */
  projects: ProjectsRepository;
  review: ReviewRepository;
  dispose(): Promise<void>;
}

export async function registerForeignOrg(): Promise<ForeignOrg> {
  const ctx = await request.newContext();
  const suffix = uniqueSuffix();
  const orgName = `e2e-foreign-${suffix}`;

  // POST /auth/register creates the org + its admin and returns the token
  // immediately (identity.py) — no invites needed for an isolation probe.
  const anonymous = new IdentityRepository(new TraceoHttp(ctx, config.apiUrl));
  const session = await anonymous.register({
    org_name: orgName,
    name: 'E2E Foreign Admin',
    email: uniqueEmail('foreign-admin'),
    password: `E2e-pass-${suffix}`,
  });

  const http = new TraceoHttp(ctx, config.apiUrl).withAuth({
    kind: 'bearer',
    token: session.token,
  });
  return {
    orgName,
    projects: new ProjectsRepository(http),
    review: new ReviewRepository(http),
    dispose: () => ctx.dispose(),
  };
}
