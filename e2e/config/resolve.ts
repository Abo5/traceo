/**
 * Single configuration resolution seam (§10): (1) explicit environment variable,
 * (2) named environment file, (3) typed default — returned as one frozen object.
 * Everything else imports THIS object, never process.env directly.
 */

export type EnvName = 'local' | 'ci' | 'staging';
export type TestLang = 'ar' | 'en';

export interface EnvConfig {
  /** Frontend origin (Next.js app). */
  baseUrl: string;
  /** Backend API root including the /v1 prefix. */
  apiUrl: string;
  /** Demo system-under-test targeted by runs. */
  sutUrl: string;
  /** UI language pinned into storage state (traceo_lang). */
  lang: TestLang;
}

const envName = (process.env.TEST_ENV ?? 'local') as EnvName;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fileCfg = require(`./envs/${envName}.json`) as EnvConfig;

export const config: Readonly<EnvConfig> = Object.freeze({
  baseUrl: process.env.BASE_URL ?? fileCfg.baseUrl, // http://localhost:3000
  apiUrl: process.env.API_URL ?? fileCfg.apiUrl, // http://localhost:8000/v1
  sutUrl: process.env.SUT_URL ?? fileCfg.sutUrl, // http://localhost:9000
  lang: (process.env.TEST_LANG ?? fileCfg.lang ?? 'ar') as TestLang,
});
