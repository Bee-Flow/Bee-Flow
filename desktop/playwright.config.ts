/**
 * End-to-end tests of the real app: `npm run e2e`.
 *
 * One worker: every test launches a whole Electron app, and two at once would
 * compete for the display and the global shortcut rather than test anything.
 * Traces are kept for failures only, and CI uploads them.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: 'e2e',
    testMatch: '**/*.spec.ts',
    workers: 1,
    fullyParallel: false,
    timeout: 90_000,
    expect: { timeout: 20_000 },
    retries: 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
    outputDir: 'e2e-results',
    use: { trace: 'retain-on-failure' },
});
