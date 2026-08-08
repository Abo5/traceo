import { faker } from '@faker-js/faker';
import type { NewProject } from '../api/types';

export type { NewProject };
export type ProjectLanguage = NewProject['language'];

export const projectFactory = (over: Partial<NewProject> = {}): NewProject => ({
  name: `e2e ${faker.string.alphanumeric(8)}`,
  language: 'ar',
  ...over,
});
