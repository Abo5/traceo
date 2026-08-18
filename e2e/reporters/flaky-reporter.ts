/**
 * Flaky-quarantine detection reporter — docs/TEST_AUTOMATION_ARCHITECTURE.md §16.
 *
 * The retry counter is a flakiness *detector*, not a green-maker (retries: 1 in CI).
 * A test that fails and then passes on retry is the §16 flake signal: it must be
 * quarantined — tagged `@flaky` (excluded from the quality gates, §18) and tracked
 * with a defect that has an owner and a fix-or-delete deadline. This reporter
 * surfaces that signal: it collects every pass-on-retry test, writes
 * `e2e/reports/flaky.json`, and prints a loud summary. No flakes → silent.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

interface FlakyEntry {
  title: string;
  file: string;
  retries: number;
  detectedAt: string;
}

const REPORT_PATH = path.resolve(__dirname, '..', 'reports', 'flaky.json');

export default class FlakyReporter implements Reporter {
  private flaky = new Map<string, FlakyEntry>();

  printsToStdout(): boolean {
    return false; // keep Playwright's default terminal reporter active
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Pass-on-retry: Playwright only retries after a failure, so a passed
    // result with retry > 0 means "failed, then passed" — the §16 flake signal.
    if (result.status === 'passed' && result.retry > 0) {
      this.flaky.set(test.id, {
        title: test.titlePath().filter(Boolean).join(' › '),
        file: path.relative(path.resolve(__dirname, '..'), test.location.file),
        retries: result.retry,
        detectedAt: new Date(result.startTime.getTime() + result.duration).toISOString(),
      });
    }
  }

  onEnd(): void {
    const tests = [...this.flaky.values()];
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ tests }, null, 2) + '\n');

    if (tests.length === 0) return; // no flakes → silent

    const lines = [
      '',
      '='.repeat(72),
      `⚠️  FLAKY TESTS DETECTED (${tests.length}) — passed only on retry`,
      '='.repeat(72),
      ...tests.map(
        (t) => `  • ${t.title}\n    ${t.file} (retries: ${t.retries})`,
      ),
      '-'.repeat(72),
      'Quarantine policy (docs/TEST_AUTOMATION_ARCHITECTURE.md §16):',
      '  1. Tag each test above @flaky — quarantined tests are excluded from',
      '     the quality gates (§18): they neither block nor rescue a merge.',
      '  2. File a tracked defect per test, with an owner and a fix deadline.',
      '  3. No permanent quarantine: past the deadline, fix it or delete it.',
      `Full list written to ${path.relative(process.cwd(), REPORT_PATH)}`,
      '='.repeat(72),
      '',
    ];
    console.log(lines.join('\n'));
  }
}
