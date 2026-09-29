/**
 * Logs in once through the real UI, walks the first-login gates, skips the
 * onboarding tour and stores the session in .auth/user.json. Specs pick that
 * up automatically through `use.storageState` in playwright.config.ts.
 *
 * A failure here means the environment is wrong (stack down, bad credentials,
 * a new gate) rather than a product regression — the error messages say so.
 */
import { chromium, type FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { AUTH_FILE, BASE_URL, TEST_USER, VIEWPORT } from './support/env';
import { suppressTour } from './support/fixtures';
import { loginThroughUi } from './support/login';

export default async function globalSetup(config: FullConfig): Promise<void> {
  // Follow the run's own --headed/--slow-mo so the login is watchable too,
  // instead of a headless browser nobody can see.
  const projectUse = (config.projects[0]?.use ?? {}) as { headless?: boolean; launchOptions?: { slowMo?: number } };
  const browser = await chromium.launch({
    headless: projectUse.headless !== false,
    slowMo: projectUse.launchOptions?.slowMo ?? 0,
  });
  const page = await browser.newPage({ viewport: VIEWPORT });

  try {
    // Also seeds the flag into the saved storageState, so even a spec that
    // bypasses the fixtures starts without a tour.
    await suppressTour(page);
    await loginThroughUi(page);
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    await page.context().storageState({ path: AUTH_FILE });
    console.log(`[global-setup] Logged in as '${TEST_USER}' at ${BASE_URL}.`);
  } catch (error) {
    await page
      .screenshot({ path: path.join(__dirname, 'test-results', 'global-setup-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
