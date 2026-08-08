/**
 * Accessibility delta gate (§18 quality gates).
 *
 * The app today ships with near-zero aria, so a raw "no violations" gate
 * would block every merge. Instead we gate on the DELTA against a committed
 * baseline: `e2e/a11y-baseline.json` (pure JSON — the mechanism is documented
 * here, not there) maps a pageKey to a SORTED array of violation fingerprints,
 * each a `"ruleId:selector"` string (axe rule id + the node's CSS target).
 *
 * - `checkA11y(page, pageKey)` scans WCAG 2.x A/AA rules and fails ONLY on
 *   fingerprints NOT present in the baseline for that pageKey. Existing debt
 *   never blocks; new debt always does. Fixed violations simply become stale
 *   baseline entries — prune them by regenerating.
 * - Regenerate/extend the baseline by running the @a11y specs with
 *   `A11Y_UPDATE_BASELINE=1` and `--workers=1` (single worker: each test
 *   rewrites the shared file). In update mode nothing fails; the scan results
 *   are written back as the new baseline for the scanned pageKeys.
 *
 * Fingerprints deliberately use the axe node target (a stable CSS selector),
 * never bilingual text (§5/§6) — selectors survive AR/EN copy changes.
 *
 * Scoping: pass `exclude` selectors for regions whose CONTENTS vary with
 * parallel-test state (e.g. entity lists other tests append to) — their node
 * count changes the nth-child fingerprints run-to-run, so scanning them makes
 * the gate nondeterministic under fullyParallel.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { E2E_ROOT } from './paths';

export const A11Y_BASELINE_FILE = path.join(E2E_ROOT, 'a11y-baseline.json');

/** WCAG 2.0/2.1 A+AA — the scope of the §18 gate; best-practice rules excluded. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

type Baseline = Record<string, string[]>;

function loadBaseline(): Baseline {
  if (!fs.existsSync(A11Y_BASELINE_FILE)) return {};
  return JSON.parse(fs.readFileSync(A11Y_BASELINE_FILE, 'utf8')) as Baseline;
}

/** One fingerprint per violating node: `"ruleId:selector"`, sorted + deduped. */
function fingerprint(ruleId: string, target: unknown): string {
  // axe targets are arrays of selectors (frames/shadow DOM) — join for stability.
  const selector = Array.isArray(target) ? target.join(' ') : String(target);
  return `${ruleId}:${selector}`;
}

export interface A11yScanOptions {
  /** CSS selectors excluded from the scan (volatile regions — see header). */
  exclude?: string[];
}

/**
 * Scan the page with axe and gate on the delta against the baseline entry for
 * `pageKey`. With A11Y_UPDATE_BASELINE=1 (run `--workers=1`), writes the scan
 * result back as the baseline instead of asserting.
 */
async function scanOnce(page: Page, options: A11yScanOptions): Promise<string[]> {
  const builder = new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    // Next.js dev-overlay portal is tooling, not the app under test.
    .exclude('nextjs-portal');
  for (const selector of options.exclude ?? []) builder.exclude(selector);
  const results = await builder.analyze();

  return [
    ...new Set(
      results.violations.flatMap((v) => v.nodes.map((n) => fingerprint(v.id, n.target))),
    ),
  ].sort();
}

/** Re-scan window: transient loading placeholders (muted "loading…" divs with
 *  no testid) can be caught mid-fetch and fingerprint differently from the
 *  settled page (e.g. `color-contrast:.stack > div:nth-child(2)` on the
 *  dashboard). The gate targets the SETTLED page: while fresh violations are
 *  present we re-scan until the deadline; violations that persist still fail. */
const SETTLE_DEADLINE_MS = 15_000;
const SETTLE_RESCAN_DELAY_MS = 1_000;

export async function checkA11y(
  page: Page,
  pageKey: string,
  options: A11yScanOptions = {},
): Promise<void> {
  let found = await scanOnce(page, options);

  if (process.env.A11Y_UPDATE_BASELINE) {
    const baseline = loadBaseline(); // read-merge-write; hence --workers=1
    baseline[pageKey] = found;
    const sortedKeys = Object.keys(baseline).sort();
    const sorted: Baseline = {};
    for (const key of sortedKeys) sorted[key] = baseline[key];
    fs.writeFileSync(A11Y_BASELINE_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
    return;
  }

  const known = new Set(loadBaseline()[pageKey] ?? []);
  let fresh = found.filter((fp) => !known.has(fp));

  // Settle loop — see SETTLE_DEADLINE_MS above. Only NEW debt triggers a
  // re-scan; a clean (or fully baselined) first scan returns immediately.
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (fresh.length > 0 && Date.now() < deadline) {
    await page.waitForTimeout(SETTLE_RESCAN_DELAY_MS);
    found = await scanOnce(page, options);
    fresh = found.filter((fp) => !known.has(fp));
  }

  expect(
    fresh,
    `NEW a11y violations on "${pageKey}" (not in a11y-baseline.json — fix them, ` +
      `or if intentional debt, regenerate the baseline with A11Y_UPDATE_BASELINE=1 --workers=1):\n` +
      fresh.map((fp) => `  - ${fp}`).join('\n'),
  ).toEqual([]);
}
