import { defineConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Load e2e/.env for local runs; real environment variables always win.
// (Deliberately dependency-free — mirrors runner/scenarios.mjs loadDotEnv.)
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
} catch {
  // best effort — missing .env is fine (CI passes everything via env)
}

const reporters: any[] = [
  ['list'],
  ['json', { outputFile: 'artifacts/pw-report.json' }],
  ['html', { outputFolder: 'playwright-report', open: 'never' }],
];
if (process.env.GITHUB_ACTIONS) reporters.push(['github']);

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: require.resolve('./tests/global-setup'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // The CI stack is a single freshly booted compose stack; more than two
  // parallel browsers just makes the LLM-backed chat scenario compete with
  // itself for the same model quota.
  workers: process.env.CI ? 2 : undefined,
  // One retry in CI: cheaper than an agentic fallback run for a plain flake.
  retries: process.env.CI ? 1 : 0,
  outputDir: 'test-results',
  reporter: reporters,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5176',
    // Desktop viewport is required: below 768px the app redirects most
    // pages back to /app (see e2e/context/app-map.md).
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
});
