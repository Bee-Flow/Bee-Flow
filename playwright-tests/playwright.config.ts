import { defineConfig, devices } from '@playwright/test';
import { AUTH_FILE, BASE_URL, VIEWPORT } from './support/env';

// A headed run is meant to be watched, so pace it by default; SLOW_MO=<ms>
// (0 = full speed) always wins.
//
// The env var is written back deliberately: worker processes re-evaluate this
// config with their own argv, where `--headed` is absent — without this they
// would run at full speed while only the main process thought it was pacing.
if (process.env.SLOW_MO === undefined && process.argv.includes('--headed')) {
  process.env.SLOW_MO = '300';
}
const SLOW_MO = Number(process.env.SLOW_MO || 0);

export default defineConfig({
  testDir: './tests',
  // One login for the whole run; every spec reuses the cookie via storageState.
  globalSetup: require.resolve('./global-setup'),
  // LLM replies stream in and can take a while on a cold local model.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    storageState: AUTH_FILE,
    ...devices['Desktop Chrome'],
    // Must stay >= 1024 wide: the Agent Hub goes mobile below 768px and
    // redirects most routes back to /app.
    viewport: VIEWPORT,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    launchOptions: { slowMo: SLOW_MO },
  },
  projects: [{ name: 'chromium' }],
});
