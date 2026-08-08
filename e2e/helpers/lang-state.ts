/**
 * Storage-state variants per UI language (@i18n lane).
 *
 * The app reads its language from localStorage `traceo_lang` (frontend/lib/
 * i18n.ts), which global/auth.setup.ts pins to `config.lang` when it composes
 * the role states. This helper reuses that composed qa_lead state — auth logic
 * is NOT duplicated — and only overrides the language key on a copy, so an
 * @i18n spec can open one context per language against the same actor.
 */
import * as fs from 'node:fs';
import type { TestLang } from '../config/resolve';
import { authStatePath } from './paths';

/** Shape of the storage-state files written by api/auth.helpers.ts. */
export interface StorageState {
  cookies: never[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/** localStorage key the frontend language store reads (frontend/lib/i18n.ts). */
const LANG_KEY = 'traceo_lang';

/**
 * The qa_lead storage state with `traceo_lang` overridden to `lang`.
 * Reads .auth/qa_lead.json fresh on every call (a new object each time — safe
 * to mutate), so it requires the setup project to have run first, exactly like
 * the role-page fixtures.
 */
export function qaLeadStateWithLang(lang: TestLang): StorageState {
  const state = JSON.parse(fs.readFileSync(authStatePath('qa_lead'), 'utf-8')) as StorageState;
  for (const origin of state.origins) {
    const entry = origin.localStorage.find((item) => item.name === LANG_KEY);
    if (entry) {
      entry.value = lang;
    } else {
      origin.localStorage.push({ name: LANG_KEY, value: lang });
    }
  }
  return state;
}
