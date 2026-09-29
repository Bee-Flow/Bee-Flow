/**
 * Regression: BFSF-136 — "Broken live example rendering in HTML/CSS styling
 * results" (Resolved) https://youtrack.beeflow.nl/issue/BFSF-136
 *
 * Reported: answers to HTML/CSS questions tried to show a live example that
 * never rendered, leaving a broken/empty placeholder in the reply.
 *
 * Root cause per the fix note: `LiveAppRenderer` loaded the example through a
 * `blob:` URL as the iframe `src`, which nginx's `default-src 'self'` CSP
 * blocks ("Framing 'blob:…' violates the following Content Security Policy").
 * The fix moved to `srcDoc` and tightened auto-promotion so a plain HTML/CSS
 * snippet (no `<script>`) stays a code block instead of becoming a live app.
 *
 * The chat renderer no longer has that live-app path at all, so this test
 * guards the *behaviour* the ticket asks for rather than the old
 * implementation: an HTML/CSS answer must render as readable content, must not
 * frame a `blob:` URL, and must not log a CSP violation.
 */
import { expect, test } from '../../support/fixtures';
import { DirectChat } from '../../support/chat';

test('BFSF-136: an HTML/CSS answer renders without a blocked blob: iframe', async ({ page }) => {
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|violates the following/i.test(text)) cspViolations.push(text);
  });

  const chat = new DirectChat(page);
  await chat.open();

  const reply = await chat.sendAndWaitForReply(
    'Show me the CSS to centre a div. Answer with one short fenced html code block ' +
      'containing a div and a <style> tag, and no explanation.',
  );

  // The answer arrived and is readable (the ticket: no empty/broken placeholder).
  await expect(reply).not.toBeEmpty();

  // A plain HTML/CSS snippet must not be promoted into a live-app iframe, and
  // nothing in a reply may ever be framed from a blob: URL — that is precisely
  // what the CSP blocked.
  await expect(reply.locator('iframe[src^="blob:"]')).toHaveCount(0);
  await expect(page.locator('iframe[src^="blob:"]')).toHaveCount(0);

  expect(cspViolations, `CSP violations logged during the turn:\n${cspViolations.join('\n')}`)
    .toEqual([]);

  // The snippet is shown as code the user can actually read.
  await expect(reply.locator('pre, code').first()).toBeVisible();
});
