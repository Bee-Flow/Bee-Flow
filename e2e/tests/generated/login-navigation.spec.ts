// AUTO-GENERATED — DO NOT EDIT BY HAND.
// Edit e2e/scenarios/login-navigation.md and run: npm run gen -- login-navigation
// scenario-hash: sha256:cf59f34faf6d6018f3095212bc3621d4ee6fe992c8b8a3386ba1d6a5beb7323c
// prompt-version: 1  app-map-hash: sha256:9634ca929a35  model: claude-fable-5
import { test, expect } from '../fixtures';

test('login-navigation: Login works and the core pages open without errors', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!process.env.ADMIN_PASSWORD, 'ADMIN_PASSWORD not set');

  await page.goto('/app');
  await page.getByTestId('username').fill(process.env.ADMIN_USER || 'admin');
  await page.getByTestId('password').fill(process.env.ADMIN_PASSWORD || '');
  await page.getByTestId('login-submit-button').click();

  // OPAQUE login adds extra round-trips after submit; an unexpected
  // first-login gate blocks here and fails with a clear message.
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 45_000 });
  await expect(page).toHaveURL(/\/app/);

  await page.goto('/app/studio/agents');
  await expect(page.getByTitle('Create empty agent').first()).toBeVisible();

  await page.goto('/app/studio/knowledge');
  await expect(
    page.getByTitle('New knowledge base').or(page.getByRole('button', { name: 'New Knowledge Base' })).first(),
  ).toBeVisible();

  await page.goto('/app/routines');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('login-submit-button')).not.toBeVisible();

  await page.getByTestId('sidebar-profile').click();
  await expect(page.getByTestId('profile-menu')).toBeVisible();
  await page.getByTestId('sidebar-signout').click();
  await expect(page.getByTestId('login-submit-button')).toBeVisible({ timeout: 20_000 });
});
