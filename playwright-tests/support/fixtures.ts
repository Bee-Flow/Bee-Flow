/**
 * Shared test fixtures. Specs import `test`/`expect` from here instead of from
 * '@playwright/test' so every test gets the onboarding-tour defences.
 *
 * Why this exists
 * ---------------
 * The 12-step onboarding tour auto-starts on the chat home for any account
 * that has not seen it, and it renders a portal overlay
 * (`OnboardingTour.jsx` — a `<div aria-live="polite">` with an aria-hidden
 * backdrop) across the whole app. That backdrop swallows pointer events, so a
 * tour that pops up mid-test turns into:
 *
 *     locator.click: Timeout ... <div aria-hidden="true"> ... intercepts pointer events
 *
 * It is a race: at full speed a test often types before the tour mounts and
 * passes, then fails on a slower machine, in --headed mode, or in CI. Two
 * independent defences, so a single change upstream cannot silently reintroduce
 * the flake:
 *
 *   1. `suppressTour` — pre-seed the "already seen" flag before app boot, so
 *      the tour never auto-starts. `scopedStorage.getItem` namespaces keys per
 *      user (`beeflow:<userId>:<key>`) but falls back to the legacy *unscoped*
 *      key, which means we can set it without knowing the user id.
 *   2. `tourAutoDismiss` — a Playwright locator handler that clicks "Skip tour"
 *      automatically if a tour appears anyway (it can also be started
 *      explicitly, e.g. from the Learning Center).
 *
 * Neither touches the account's server-side state, so runs stay repeatable and
 * the real first-run experience is left intact for humans.
 */
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** localStorage flag the tour checks before auto-starting (tourSteps.ts). */
export const TOUR_SEEN_KEY = 'hasSeenIntroTour';

/** Runs before any app code on every page/navigation in the context. */
export async function suppressTour(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      /* storage disabled — the auto-dismiss handler still covers us */
    }
  }, TOUR_SEEN_KEY);
}

/** Clicks "Skip tour" automatically whenever a tour blocks an action. */
export async function installTourAutoDismiss(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: /skip tour/i }).first();
  await page.addLocatorHandler(skip, async (button) => {
    await button.click({ timeout: 5_000 }).catch(() => {});
  }, { noWaitAfter: true });
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await suppressTour(page);
    await installTourAutoDismiss(page);
    await use(page);
  },
});

export { expect };
