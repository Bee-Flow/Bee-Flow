// AUTO-GENERATED — DO NOT EDIT BY HAND.
// Edit e2e/scenarios/direct-chat.md and run: npm run gen -- direct-chat
// scenario-hash: sha256:602c3a87a1c67318767f22e8d6042f9da2e754ff0658a8ab63d81928ddadd89d
// prompt-version: 1  app-map-hash: sha256:9634ca929a35  model: claude-fable-5
import { test, expect, AUTH_FILE } from '../fixtures';

test.use({ storageState: AUTH_FILE });

test('direct-chat: Direct chat sends a message and receives a real LLM reply', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/app');
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-new-chat').click();

  const input = page.getByTestId('chat-message-input');
  await expect(input).toBeVisible();
  const prompt = 'Reply with only the single word PONG and nothing else.';
  await input.fill(prompt);
  await page.getByTestId('send-message-button').click();

  const messages = page.locator('[data-testid^="message-"]');
  await expect(messages.first()).toContainText('single word PONG', { timeout: 30_000 });
  // The assistant reply streams via SSE; assert on the eventual text.
  await expect(messages.nth(1)).toContainText(/pong/i, { timeout: 90_000 });

  // Composer is back in idle state: send button visible, input empty and usable.
  await expect(page.getByTestId('send-message-button')).toBeVisible({ timeout: 30_000 });
  await expect(input).toBeEmpty();
  await expect(input).toBeEditable();
});
