/**
 * Expected UI strings resolved from the SOURCE OF TRUTH — the production
 * dictionaries in frontend/lib/i18n.ts — never hardcoded in specs (§6).
 *
 * The dictionaries (`ar`, `en`) are module-private there, and the module is a
 * "use client" file importing react, so it cannot be imported from e2e without
 * coupling the suite to frontend/node_modules. Instead the source is read and
 * its dictionary object literals parsed: every entry is a single-line
 * `key: "value",` pair with no escapes or interpolation, which the parser
 * enforces by failing loudly when a dictionary comes back empty or a key is
 * missing — a drift alarm, not a silent fallback.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestLang } from '../config/resolve';
import { E2E_ROOT } from './paths';

const I18N_SOURCE = path.resolve(E2E_ROOT, '..', 'frontend', 'lib', 'i18n.ts');

type Dict = Readonly<Record<string, string>>;

function parseDict(source: string, lang: TestLang): Dict {
  const header = `const ${lang}: Dict = {`;
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`i18n-dictionary: '${header}' not found in ${I18N_SOURCE}`);
  }
  const end = source.indexOf('\n};', start);
  if (end === -1) {
    throw new Error(`i18n-dictionary: unterminated '${header}' literal in ${I18N_SOURCE}`);
  }

  const dict: Record<string, string> = {};
  const body = source.slice(start + header.length, end);
  for (const match of body.matchAll(/^\s*([A-Za-z0-9_]+):\s*"([^"\\]*)",?\s*$/gm)) {
    dict[match[1]] = match[2];
  }
  if (Object.keys(dict).length === 0) {
    throw new Error(`i18n-dictionary: parsed 0 entries for '${lang}' from ${I18N_SOURCE}`);
  }
  return Object.freeze(dict);
}

let dicts: Record<TestLang, Dict> | undefined;

/** Expected UI string for `key` in `lang`; throws on unknown keys (fail fast). */
export function uiText(lang: TestLang, key: string): string {
  if (!dicts) {
    const source = fs.readFileSync(I18N_SOURCE, 'utf-8');
    dicts = { ar: parseDict(source, 'ar'), en: parseDict(source, 'en') };
  }
  const value = dicts[lang][key];
  if (value === undefined) {
    throw new Error(`i18n-dictionary: key '${key}' missing from the '${lang}' dictionary`);
  }
  return value;
}
