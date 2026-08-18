import { faker } from '@faker-js/faker';
import type { NewProject } from '../api/types';

export type { NewProject };

/**
 * Default project seed for fixtures and specs.
 *
 * A project has no language: Traceo is English-only, so `name` and
 * `automation` are the whole creation surface.
 *
 * `automation` defaults to "manual" HERE (the SERVER default is "auto"):
 * fixtures arrange state explicitly over the API (confirm_all / generate), and
 * on an automation:"auto" project the autopilot would ALSO auto-confirm and
 * auto-generate after a parse/import — racing those explicit calls and making
 * arranged state nondeterministic. "manual" keeps arrangement deterministic;
 * only the autopilot spec opts back into "auto".
 */
export const projectFactory = (over: Partial<NewProject> = {}): NewProject => ({
  name: `e2e ${faker.string.alphanumeric(8)}`,
  automation: 'manual',
  ...over,
});
