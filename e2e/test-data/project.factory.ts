import { faker } from '@faker-js/faker';
import type { NewProject } from '../api/types';

export type { NewProject };
export type ProjectLanguage = NewProject['language'];

/**
 * Default project seed for fixtures and specs.
 *
 * - `language` is OMITTED by default — it is optional on the wire (autopilot
 *   contract: omitted/null => the backend auto-detects it from the first parsed
 *   document). Specs that need a deterministic language use
 *   `projectWithLanguage()` below.
 * - `automation` defaults to "manual" HERE (the SERVER default is "auto"):
 *   fixtures arrange state explicitly over the API (confirm_all / generate),
 *   and on an automation:"auto" project the autopilot would ALSO auto-confirm
 *   and auto-generate after a parse/import — racing those explicit calls and
 *   making arranged state nondeterministic. "manual" keeps arrangement
 *   deterministic; only the autopilot spec opts back into "auto".
 */
export const projectFactory = (over: Partial<NewProject> = {}): NewProject => ({
  name: `e2e ${faker.string.alphanumeric(8)}`,
  automation: 'manual',
  ...over,
});

/** Variant with an explicit language — for specs that need language determinism. */
export const projectWithLanguage = (
  language: 'en' | 'ar',
  over: Partial<NewProject> = {},
): NewProject => projectFactory({ language, ...over });
