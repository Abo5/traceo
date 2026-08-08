/**
 * Domain matchers (§6) — failures read in Traceo's language. Assertions live in
 * specs and here, never inside page objects.
 */
import { expect as baseExpect } from '@playwright/test';
import type { TestCaseState } from '../constants/states';
import type { TestCase } from '../api/types';

/** Any object that can prove traceability: API cases carry `links`/`requirements`. */
type TracedCase = Partial<Pick<TestCase, 'id' | 'links' | 'requirements'>> & {
  requirement_ids?: string[];
};

function linkedRequirementIds(received: TracedCase): string[] {
  if (received.requirement_ids) return received.requirement_ids;
  const links = received.links ?? received.requirements ?? [];
  return links.map((l) => l.id);
}

export const expect = baseExpect.extend({
  toBeInState(received: Pick<TestCase, 'id' | 'state'>, state: TestCaseState) {
    const pass = received.state === state;
    return {
      pass,
      message: () =>
        `expected test case ${received.id} to be ${state}, got ${received.state}`,
    };
  },

  toTraceTo(received: TracedCase, requirementId: string) {
    const ids = linkedRequirementIds(received);
    const pass = ids.includes(requirementId);
    return {
      pass,
      message: () =>
        pass
          ? `test case ${received.id} traces to ${requirementId}, expected it not to`
          : `test case ${received.id} does not trace to ${requirementId} (BO-07); linked: [${ids.join(', ')}]`,
    };
  },
});
