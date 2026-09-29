/**
 * Logging in through the real UI.
 *
 * The Agent Hub has no /login route: an unauthenticated /app URL renders the
 * login form in place. The session is a plain HTTP cookie, which is why one
 * login in global-setup can be reused by every spec via storageState.
 */
import type { Page } from '@playwright/test';
import { BASE_URL, TEST_PASSWORD, TEST_USER } from './env';
import { passPostLoginGates, skipOnboardingTour } from './gates';

export async function loginThroughUi(
  page: Page,
  user: string = TEST_USER,
  password: string = TEST_PASSWORD,
): Promise<void> {
  await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' });

  await page.getByTestId('username').fill(user, { timeout: 30_000 });
  await page.getByTestId('password').fill(password);
  await page.getByTestId('login-submit-button').click();

  // Migrated accounts run an OPAQUE handshake after submit — same button, no
  // extra UI, just extra round-trips. Bad credentials surface as a red alert,
  // so poll for "left the login form" and fail fast on a rejection.
  const failure = page.getByText(/login failed|invalid (email|credentials)|incorrect password/i).first();
  const loginForm = page.getByTestId('login-submit-button');

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await failure.isVisible().catch(() => false)) {
      throw new Error(`Login rejected for '${user}': ${(await failure.innerText()).trim()}`);
    }
    if (!(await loginForm.isVisible().catch(() => false))) break;
    await page.waitForTimeout(400);
  }

  await passPostLoginGates(page);
  await skipOnboardingTour(page);
}
