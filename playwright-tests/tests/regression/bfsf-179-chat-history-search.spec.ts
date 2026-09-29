/**
 * Regression: BFSF-179 — "Chat History Not Reliably Retrievable" (Resolved, Major)
 * https://youtrack.beeflow.nl/issue/BFSF-179
 *
 * Reported: chat history search returned inconsistent and incomplete results —
 * different hits on each run, and today's conversations missing entirely.
 *
 * The ticket's own audit found three defects behind it: a stuck
 * `messages_migrated` flag pushing recent conversations onto the weakest search
 * strategy, non-deterministic ordering/dedupe across the three strategies, and
 * a SearchOverlay default sort of 'relevance' instead of date.
 *
 * This test follows the verification recipe from that audit: create several
 * conversations today containing a unique token, then search for it.
 *
 * Note: the shortcut named in the ticket (Ctrl+Alt+R) never existed in the app.
 * Ctrl+K is the real binding — see support/search.ts.
 */
import { expect, test } from '../../support/fixtures';
import { DirectChat } from '../../support/chat';
import { SearchOverlay } from '../../support/search';

test('BFSF-179: today\'s conversations are findable, newest first, and the result set is stable', async ({
  page,
}) => {
  // Two LLM round-trips plus searching — needs more than the default budget.
  test.setTimeout(240_000);

  // Unique per run so parallel runs and earlier runs can never pollute the hits.
  const token = `bfsf179${Date.now().toString(36)}`;
  const chat = new DirectChat(page);

  // Oldest first, so the *second* conversation must rank first afterwards.
  await chat.open();
  await chat.sendAndWaitForReply(`Codeword ${token}. Reply with exactly: first ${token}`);
  const firstConvId = new URL(page.url()).pathname.split('/').pop();

  await chat.open();
  await chat.sendAndWaitForReply(`Codeword ${token}. Reply with exactly: second ${token}`);
  const secondConvId = new URL(page.url()).pathname.split('/').pop();

  expect(secondConvId, 'the two conversations must be distinct').not.toBe(firstConvId);

  const search = new SearchOverlay(page);
  await search.open();

  // Completeness: both of today's conversations come back, not just one.
  const firstPass = await search.search(token, 2);

  // Ordering: most recently updated first (the fix switched the default sort
  // from 'relevance' to date).
  expect(firstPass[0]).toContain(secondConvId!.slice(0, 8));

  // Determinism: the same query must produce the same ordered result set.
  // This is the part that used to vary run to run.
  await search.close();
  await search.open();
  const secondPass = await search.search(token, 2);
  expect(secondPass, 'repeating the same search must return an identical ordered list').toEqual(
    firstPass,
  );

  // And a third time from a clean overlay, since the reported flakiness was
  // intermittent rather than every-other-run.
  await search.close();
  await search.open();
  expect(await search.search(token, 2)).toEqual(firstPass);
});
