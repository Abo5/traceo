import { faker } from '@faker-js/faker';
import type { NewTestCase } from '../api/types';

/**
 * Manual case — the contract enforces traceability: empty requirement_ids is
 * rejected with 422 `missing_requirements` (FR-REV-07 / FR-GEN-02), so the
 * factory takes the ids as a required argument.
 */
export const manualCaseFactory = (
  requirementIds: string[],
  over: Partial<NewTestCase> = {},
): NewTestCase => ({
  title: faker.lorem.words(4),
  type: 'positive',
  requirement_ids: requirementIds,
  ...over,
});
