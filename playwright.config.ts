/**
 * The end-to-end tests (Story 3.5, Epic 2 retro B8): Playwright's
 * `_electron` launches the production build that `npm run e2e` puts in
 * `.vite/` (scripts/e2e-build.mjs). Only `test/e2e/*.spec.ts`; vitest takes
 * `*.test.ts` only, so neither runner picks up the other's files.
 *
 * One worker: each test file launches the whole app. The timeout covers a
 * launch, the sandbox's boot and SANDBOX_IDLE_MS of waiting for it to be
 * destroyed. No screenshots, videos or traces. In CI the HTML report is
 * written too, for the job to upload when it fails.
 */
import { defineConfig } from '@playwright/test';
import { SANDBOX_IDLE_MS } from './src/shared/constants';

const CI = process.env.CI !== undefined && process.env.CI !== '';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: 0,
  timeout: SANDBOX_IDLE_MS + 120_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  reporter: CI
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
