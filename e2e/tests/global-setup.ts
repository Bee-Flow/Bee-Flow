/**
 * Logs in once through the real UI and saves the session cookie as
 * Playwright storageState (.auth/admin.json). Specs for `auth: admin`
 * scenarios reuse it via `test.use({ storageState: AUTH_FILE })`.
 *
 * A failure here means the environment is broken (stack down, wrong
 * credentials, unexpected auth gate) — runner/smoke.mjs reports that as an
 * infra error (exit 3), not as a test regression.
 */
import { chromium, type FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

// Confirm-button names for first-login gates we may encounter (the recovery-key
// modal). CI consumes the recovery key via an API login probe before this runs,
// but local stacks can still show it.
const DISMISS_BUTTONS: RegExp[] = [
  /i (have )?(saved|stored)/i,
  /continue/i,
  /accept/i,
  /agree/i,
  /got it/i,
  /close/i,
  /doorgaan/i,
  /akkoord/i,
  /sluiten/i,
];

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env.BASE_URL || 'http://localhost:5176';
  const user = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error('[global-setup] ADMIN_PASSWORD is not set — cannot log in (infra).');
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseURL}/app`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('username').fill(user, { timeout: 30_000 });
    await page.getByTestId('password').fill(password);
    await page.getByTestId('login-submit-button').click();

    // OPAQUE login runs extra round-trips after submit; then zero or more
    // one-time gates may appear before the app shell. Poll for the sidebar
    // while defensively dismissing known modals.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await page.getByTestId('sidebar').isVisible().catch(() => false)) break;

      const mfa = await page
        .getByText(/multi.?factor|two.?factor|authenticator app/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (mfa) {
        throw new Error(
          '[global-setup] Login hit an MFA gate. The smoke stack must disable ' +
            "'require_mfa_for_password_accounts' before the suite runs (infra).",
        );
      }

      for (const name of DISMISS_BUTTONS) {
        const btn = page.getByRole('button', { name }).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click().catch(() => {});
          break;
        }
      }
      await page.waitForTimeout(500);
    }

    if (!(await page.getByTestId('sidebar').isVisible().catch(() => false))) {
      throw new Error(
        `[global-setup] Sidebar never appeared after login as '${user}' at ${baseURL} (infra). ` +
          'Check credentials, stack health, and first-login gates.',
      );
    }

    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    await page.context().storageState({ path: AUTH_FILE });
  } finally {
    await browser.close();
  }
}
