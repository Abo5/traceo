/** Absolute paths anchored to the e2e/ root — safe under any working directory. */
import * as path from 'node:path';
import type { Role } from '../constants/roles';

export const E2E_ROOT = path.resolve(__dirname, '..');
export const AUTH_DIR = path.join(E2E_ROOT, '.auth');
export const TEST_DATA_DIR = path.join(E2E_ROOT, 'test-data');

/** storageState file for a role, written by global/auth.setup.ts. */
export function authStatePath(role: Role): string {
  return path.join(AUTH_DIR, `${role}.json`);
}

/** Credentials + tokens of the run org's four actors (setup output, gitignored). */
export const ACTORS_FILE = path.join(AUTH_DIR, 'actors.json');
