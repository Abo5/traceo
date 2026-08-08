import { defineConfig, devices } from '@playwright/test';
import { config as env } from './config/resolve';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0, // الإعادة كاشف هشاشة (§16)
  workers: process.env.CI ? 4 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['junit', { outputFile: 'reports/junit/results.xml' }],
    ['./reporters/flaky-reporter.ts'], // pass-on-retry detection → reports/flaky.json (§16)
  ],
  use: {
    baseURL: env.baseUrl,
    trace: 'on-first-retry',
    video: 'on-first-retry',
    screenshot: 'only-on-failure',
    testIdAttribute: 'data-testid',
  },
  projects: [
    // setup lives in global/ (§2 tree), outside the specs' testDir
    { name: 'setup', testDir: './global', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },
  ],
});
