/**
 * Direct chat — the "just talk to the AI" path: /app → New Chat → send → reply.
 *
 * Authentication comes from global-setup.ts via storageState, so these tests
 * start already logged in as TEST_USER.
 */
import { expect, test } from '../support/fixtures';
import { DirectChat } from '../support/chat';

test.describe('Direct chat', () => {
  test('sends a message and receives a reply from the model', async ({ page }) => {
    const chat = new DirectChat(page);
    await chat.open();

    const prompt = 'Reply with only the single word PONG and nothing else.';
    await chat.send(prompt);

    // The user's own message is echoed into the conversation immediately.
    await expect(chat.userMessages.last()).toContainText(prompt, { timeout: 30_000 });

    // The reply streams in over SSE — assert on the settled text, never on a
    // fixed wait.
    const reply = await chat.waitForReply();
    await expect(reply).toContainText(/pong/i, { timeout: 30_000 });

    // A full turn is two messages, and the composer is usable again.
    await expect(chat.messages).toHaveCount(2);
    await expect(chat.input).toBeEmpty();
    await expect(chat.input).toBeEditable();

    // The conversation is now persisted: the app rewrites the URL to /d/<id>
    // and the chat shows up in the sidebar.
    await expect(page).toHaveURL(/\/d\/[0-9a-f]{8}/i);
    await expect(page.locator('[data-testid^="conv-row-"]').first()).toBeVisible();

    // No error surfaced during the turn.
    await expect(page.getByTestId('msg-guardrail-warning')).toHaveCount(0);
    await expect(page.getByText(/something went wrong|failed to send/i)).toHaveCount(0);
  });

  test('composer only allows sending when there is something to send', async ({ page }) => {
    const chat = new DirectChat(page);
    await chat.open();

    await expect(chat.input).toHaveAttribute('placeholder', 'Message AI...');
    await expect(chat.sendButton).toBeDisabled();

    await chat.input.click();
    await chat.input.fill('draft');
    await expect(chat.sendButton).toBeEnabled();

    // Shift+Enter is a newline, not a send: nothing must leave the composer.
    await chat.input.press('Shift+Enter');
    await chat.input.pressSequentially('second line');
    await expect(chat.input).toHaveValue(/draft\nsecond line/);
    await expect(chat.messages).toHaveCount(0);

    await chat.input.fill('');
    await expect(chat.sendButton).toBeDisabled();
  });
});
