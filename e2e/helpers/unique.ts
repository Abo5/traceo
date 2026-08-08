/** Pure uniqueness helpers — fresh org/emails per run (§9). */
import { randomBytes } from 'node:crypto';

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export function uniqueEmail(label: string): string {
  return `e2e-${label}-${uniqueSuffix()}@traceo.test`;
}
