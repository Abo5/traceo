/**
 * Setup project (§9) — provisions the run org and builds one storage-state file
 * per role, entirely over the API. No browser: the token lives in localStorage
 * (frontend/lib/api.ts), so states are COMPOSED, not recorded. The UI login
 * flow itself stays covered by dedicated @smoke specs.
 *
 * A failure here aborts the whole run early (the browser project depends on
 * this one) instead of producing hundreds of opaque failures.
 */
import * as fs from 'node:fs';
import { request, test as setup } from '@playwright/test';
import { registerWorkerOrg, storageStateFor } from '../api/auth.helpers';
import { TraceoHttp } from '../api/http';
import { config } from '../config/resolve';
import { ACTORS_FILE, AUTH_DIR, authStatePath } from '../helpers/paths';

setup('provision org and role states', async () => {
  const ctx = await request.newContext();
  try {
    const http = new TraceoHttp(ctx, config.apiUrl);
    const org = await registerWorkerOrg(http); // admin + qa_lead + qa_engineer + viewer

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const actor of org.actors) {
      fs.writeFileSync(
        authStatePath(actor.role),
        JSON.stringify(storageStateFor(actor), null, 2),
      );
    }
    // tokens + credentials for ApiClient.forWorkerOrg (gitignored alongside the states)
    fs.writeFileSync(ACTORS_FILE, JSON.stringify(org, null, 2));
  } finally {
    await ctx.dispose();
  }
});
