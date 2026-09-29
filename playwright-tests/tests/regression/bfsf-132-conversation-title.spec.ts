/**
 * Regression: BFSF-132 — "Geeft geen naam voor de chat in chathistorie" (Closed)
 * https://youtrack.beeflow.nl/issue/BFSF-132
 *
 * Reported: conversations showed up in the sidebar history without a name, so
 * users could not find earlier conversations back ("Nu kan je gesprekken niet
 * terugzoeken").
 *
 * Guards: after the first exchange the conversation must appear in the sidebar
 * with a generated, human-readable title — not blank and not still the
 * placeholder "New Chat".
 */
import { expect, test } from '../../support/fixtures';
import { DirectChat } from '../../support/chat';

const PLACEHOLDER_TITLES = /^(new chat|nieuwe chat|untitled|naamloos)$/i;

test('BFSF-132: a new conversation gets a real title in the sidebar history', async ({ page }) => {
  const chat = new DirectChat(page);
  await chat.open();

  await chat.sendAndWaitForReply('Give me one short tip for writing clear meeting notes.');

  // The conversation is the one the URL now points at.
  const convId = new URL(page.url()).pathname.split('/').pop();
  expect(convId, 'the app should have rewritten the URL to /d/<id>').toBeTruthy();

  const row = page.locator(`[data-testid^="conv-row-"]`).first();
  await expect(row).toBeVisible();

  // Titling happens right after the first reply, but it is server-side and
  // asynchronous — poll rather than assert once.
  await expect
    .poll(async () => (await row.innerText()).trim(), {
      message: 'conversation title should stop being blank/placeholder',
      timeout: 30_000,
    })
    .not.toMatch(PLACEHOLDER_TITLES);

  const title = (await row.innerText()).trim();
  expect(title.length, `title was ${JSON.stringify(title)}`).toBeGreaterThan(2);

  // The whole point of the ticket: you can find the conversation back by name.
  await expect(page.getByTestId('sidebar')).toContainText(title);
});
