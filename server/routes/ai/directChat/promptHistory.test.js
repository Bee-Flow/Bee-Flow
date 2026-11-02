/**
 * resolveHistory: when the turn falls back to the stored rows of the
 * conversation, their attachment sidecars are marked persisted, so the
 * hydrator keeps re-signing earlier images. A client-sent history is not.
 *
 * Run: cd server && node --test routes/ai/directChat/promptHistory.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { isPersistedSidecar } = require('../../../core/conversation/historyMerge');
const { makeSwaps } = require('../../../testUtils/swaps');
const agentStore = require('../../../stores/agentStore');

/** @type {any[]} */
let storedMessages = [];
const { swap, restore } = makeSwaps();
swap(agentStore, 'getDirectConversation', async () => ({ messages: storedMessages }));
const { resolveHistory } = require('./promptHistory');
test.after(restore);

const req = /** @type {any} */ ({ session: {} });

test('the stored history of the conversation is marked persisted', async () => {
    const att = { name: 'a.png', storageKey: 'users/u2/a.png' };
    storedMessages = [{ role: 'user', content: 'look', attachments: [att] }];
    const { resolvedHistory, clientHistoryProvided } = await resolveHistory({ req, userId: 'u1', conversationId: 'c1', history: [] });
    assert.strictEqual(clientHistoryProvided, false);
    assert.strictEqual(resolvedHistory, storedMessages);
    assert.strictEqual(isPersistedSidecar(att), true);
});

test('a sidecar sent by the client with no stored counterpart is not marked', async () => {
    storedMessages = [];
    const att = { name: 'b.png', storageKey: 'users/u2/b.png' };
    const { resolvedHistory } = await resolveHistory({ req, userId: 'u1', conversationId: 'c1', history: [{ role: 'user', content: 'x', attachments: [att] }] });
    assert.strictEqual(resolvedHistory?.[0].attachments?.[0], att);
    assert.strictEqual(isPersistedSidecar(att), false);
});
