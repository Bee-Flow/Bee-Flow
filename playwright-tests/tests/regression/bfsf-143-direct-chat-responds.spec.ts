/**
 * Regression: BFSF-143 — "Bee Flow direct chat fails to react" (Resolved,
 * Show-stopper) https://youtrack.beeflow.nl/issue/BFSF-143
 *
 * Reported: direct chat sat on "thinking" for ~5 minutes and then failed with
 * a provider error ("Something went wrong", `minimax API error 400: invalid
 * function arguments json string`), with tool calls degenerating into
 * "Tool call had no function name — skipped". Other chats crashed to a white
 * screen, and opening them from history hit the same white screen.
 *
 * Guards the three observable symptoms: the reply arrives inside a sane
 * budget, no provider/error banner is rendered, and neither the conversation
 * nor its history entry white-screens afterwards.
 */
import { expect, test } from '../../support/fixtures';
import { DirectChat } from '../../support/chat';

/** Error strings from the ticket, plus the generic banner text. */
const ERROR_TEXT =
  /something went wrong|api error \d{3}|invalid function arguments|had no function name|error generating response/i;

test('BFSF-143: direct chat answers in time, without an error banner or white screen', async ({
  page,
}) => {
  const chat = new DirectChat(page);
  await chat.open();

  const started = Date.now();
  const reply = await chat.sendAndWaitForReply('In one sentence: what is a knowledge base?');
  const elapsedMs = Date.now() - started;

  // The ticket's complaint was ~5 minutes to a timeout. 90s is the suite's
  // reply budget; assert explicitly so a slow regression fails loudly here.
  expect(elapsedMs, 'reply took too long').toBeLessThan(90_000);

  await expect(reply).not.toBeEmpty();
  await expect(reply).not.toHaveText(ERROR_TEXT);
  await expect(page.getByText(ERROR_TEXT)).toHaveCount(0);

  // Not a white screen: the shell and the conversation are both still there.
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(chat.messages).toHaveCount(2);

  // Re-opening the conversation from history must not white-screen either —
  // the second half of the report.
  const conversationUrl = page.url();
  await page.reload();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('chat-message-input')).toBeVisible();
  await expect(chat.messages).toHaveCount(2);
  expect(page.url()).toBe(conversationUrl);
  await expect(page.getByText(ERROR_TEXT)).toHaveCount(0);
});
