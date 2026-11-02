/**
 * The stored history of a conversation is marked as persisted before the
 * hydrator runs, so the attachment sidecars of earlier turns (owned by the
 * thread, possibly uploaded by another member of a shared thread) keep being
 * re-signed. A history that arrived from the client is not marked.
 *
 * Run: cd server && node --test core/agentRuntime/chatStream/turnHistory.persisted.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { isPersistedSidecar } = require('../../conversation/historyMerge');
const { makeSwaps } = require('../../../testUtils/swaps');

/** @type {boolean[]} what the hydrator saw: persisted or not, per history attachment */
let seen = [];
// turnHistory.js takes these by destructuring, so they are swapped before it loads.
const { swap, restore } = makeSwaps();
swap(require('../historyHydrator'), 'hydrateHistoryAttachments', async (/** @type {any[]} */ messages) => {
    seen = messages.flatMap((m) => (m.attachments || []).map((/** @type {object} */ a) => isPersistedSidecar(a)));
});
swap(require('../attachmentIntake'), 'appendUserTurn', async () => ({ userSave: null, promptUserMsg: null }));
swap(require('../phaseEvents'), 'withPhase', async (/** @type {any} */ _e, /** @type {any} */ _p, /** @type {any} */ _d, /** @type {() => any} */ fn) => fn());
swap(require('../../llm/contextPolicy'), 'resolveContextPolicy', async () => { throw new Error('not in this test'); });
const { assembleTurnHistory } = require('./turnHistory');
test.after(restore);

/** @param {Record<string, unknown>} over */
const run = (over) => assembleTurnHistory(/** @type {any} */ ({
    agent: {}, userId: 'u1', userMessage: 'hi', userAuth: { userId: 'u1' }, messageMetadata: {},
    modelToUse: 'm', isEphemeral: false, historyOverride: null, onEvent: () => {}, _sharedThread: null,
    ...over,
}));

const stored = () => [
    { role: 'user', content: 'look', attachments: [{ name: 'a.png', storageKey: 'users/u2/a.png' }] },
    { role: 'assistant', content: 'seen' },
];

test('a history loaded from the database is marked persisted before hydration', async () => {
    seen = [];
    await run({ conversation: { id: 'c1', messages: stored() } });
    assert.deepStrictEqual(seen, [true]);
});

test('an ephemeral conversation marks nothing', async () => {
    seen = [];
    const messages = stored();
    await run({ conversation: { id: 'e1', messages }, isEphemeral: true });
    assert.strictEqual(isPersistedSidecar(/** @type {any} */ (messages[0].attachments)[0]), false);
});
