/**
 * First-login gates and overlays that stand between "credentials accepted" and
 * "you can click things".
 *
 * Observed on a fresh account against the local stack, in this order:
 *   1. EncryptionSetup     — "Save Your Recovery Key" (full-screen)
 *   2. ReconsentGate       — "Our terms have been updated" (full-screen;
 *                            the checkbox must be ticked before the button
 *                            enables)
 *   3. OnboardingTour      — 12-step spotlight tour that auto-starts on the
 *                            chat home. Its overlay swallows clicks on the
 *                            composer, so it MUST be skipped before typing.
 *
 * All three are one-time per user and are stored server-side, so after the
 * first successful run they simply never appear again. Everything here is
 * therefore best-effort: present → handle it, absent → move on.
 */
import type { Page } from '@playwright/test';

/** Buttons that confirm a full-screen gate. Order matters: most specific first. */
const GATE_CONFIRM_BUTTONS: RegExp[] = [
  /saved my recovery key/i, // "I've saved my recovery key — Continue"
  /i accept the updated terms/i, // ReconsentGate
  /^continue$/i,
  /^got it$/i,
];

/**
 * Clicks through post-login gates until the app shell (`sidebar`) is up.
 * Throws on gates a test account cannot pass (MFA enrolment, no organisation).
 */
export async function passPostLoginGates(page: Page, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await page.getByTestId('sidebar').isVisible().catch(() => false)) return;

    const blocked = await page
      .getByText(/set up two.factor|no organisation found|awaiting approval/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (blocked) {
      const what = await page.locator('h1, h2').first().innerText().catch(() => 'unknown gate');
      throw new Error(
        `Login hit a gate this account cannot pass: "${what.trim()}". ` +
          'Fix the account/stack configuration — this is an environment problem, not a test failure.',
      );
    }

    // ReconsentGate: the submit button stays disabled until the box is ticked.
    const consentBox = page.locator('input[type="checkbox"]').first();
    if (await consentBox.isVisible().catch(() => false)) {
      await consentBox.check().catch(() => {});
    }

    for (const name of GATE_CONFIRM_BUTTONS) {
      const button = page.getByRole('button', { name }).first();
      if (!(await button.isVisible().catch(() => false))) continue;
      if (await button.isDisabled().catch(() => false)) continue;
      await button.click().catch(() => {});
      break;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    'The app shell (sidebar) never appeared after login. Check the stack, the credentials, ' +
      'and whether a new first-login gate was added.',
  );
}

/**
 * Dismisses the onboarding tour if it is running. The tour renders a portal
 * overlay on top of the whole app, so an un-skipped tour shows up as
 * "click timed out / element is not receiving pointer events".
 */
export async function skipOnboardingTour(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: /skip tour/i }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await skip.isVisible().catch(() => false))) return;
    await skip.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}
