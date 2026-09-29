/**
 * nextcloud deck.card.moved — the from/to stack filter reads the keys the
 * connector actually publishes.
 *
 * The payload carries the card's CURRENT stack as `stackId` and the one it
 * left as `previousStackId` (triggerSources/declared/nextcloud.js); there is
 * no fromStackId/toStackId on the wire. Until 2026-09-17 the matcher compared
 * the filter's own key names against the payload, so "when a card lands in
 * Done" never fired once. Found while verifying the lean ## Triggers block
 * against every filter key filters.js reads.
 *
 * Run: node --test --test-force-exit automation/triggerBus/filters.deckMoved.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { pickMatcher, matchNextcloudDeckCardMovedFilter } = require('./filters');

const moved = (over = {}) => ({
    cardId: 4521,
    boardId: 12,
    stackId: 36,
    previousStackId: 34,
    title: 'Follow up with Nextcloud',
    done: null,
    ...over,
});

test('deck.card.moved dispatches to its own matcher', () => {
    assert.strictEqual(pickMatcher('nextcloud', 'deck.card.moved'), matchNextcloudDeckCardMovedFilter);
});

test('toStackId matches the stack the card is in NOW (payload.stackId)', () => {
    const m = matchNextcloudDeckCardMovedFilter;
    assert.strictEqual(m(moved(), { toStackId: 36 }), true);
    assert.strictEqual(m(moved(), { toStackId: '36' }), true, 'ids compare as strings');
    assert.strictEqual(m(moved(), { toStackId: 34 }), false, 'the stack it LEFT is not the destination');
});

test('fromStackId matches the stack the card LEFT (payload.previousStackId)', () => {
    const m = matchNextcloudDeckCardMovedFilter;
    assert.strictEqual(m(moved(), { fromStackId: 34 }), true);
    assert.strictEqual(m(moved(), { fromStackId: 36 }), false);
    assert.strictEqual(m(moved(), { fromStackId: 34, toStackId: 36 }), true, 'both together describe one move');
    assert.strictEqual(m(moved(), { fromStackId: 34, toStackId: 35 }), false);
});

test('the shared card filters still apply on top (board, stack, title)', () => {
    const m = matchNextcloudDeckCardMovedFilter;
    assert.strictEqual(m(moved(), { boardId: 12, toStackId: 36 }), true);
    assert.strictEqual(m(moved(), { boardId: 13, toStackId: 36 }), false);
    assert.strictEqual(m(moved(), { titleContains: 'nextcloud', toStackId: 36 }), true);
    assert.strictEqual(m(moved(), {}), true, 'no filter = every move');
    assert.strictEqual(m(moved(), null), true);
});
