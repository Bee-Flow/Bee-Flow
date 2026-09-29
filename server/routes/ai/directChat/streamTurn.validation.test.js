/**
 * What a direct-chat turn may carry (routes/ai/directChat/streamTurn.js,
 * ./turnSchema.js) — typed, not closed: the chat engine's bag carries its
 * host's extras, so an unknown key is expected here.
 *
 *   - `webSearchEnabled: "false"` searched the web; `memoryWriteEnabled:
 *     "false"` wrote the turn to memory. "false" now reads as false.
 *   - a `history` that is not a list reached `.map` after the SSE headers.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/ai/directChat/streamTurn.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../../core/http/routeHarness');
const { DirectTurnBody } = require('./turnSchema');

const { db, api } = h.routeUnderTest(test, '/ai', () => require('./streamTurn'));
const post = (body, user) => api.call('POST', '/ai/chat/direct/stream', { body, user });

test('the keys the turn reads have the types it assumes', async () => {
    h.assertRefused(assert, await post({ message: 'hi', webSearchEnabled: 'no' }), 'body.webSearchEnabled', /true or false/);
    h.assertRefused(assert, await post({ message: 'hi', history: 'earlier' }), 'body.history', /history is a list/);
    h.assertRefused(assert, await post({ message: { text: 'hi' } }), 'body.message', /message is text/);
    assert.deepStrictEqual(db.queries, []);
});

test('"false" as text is read as false, and a host extra passes through', () => {
    const parsed = DirectTurnBody.parse({ message: 'hi', webSearchEnabled: 'false', memoryWriteEnabled: 'false', sidePanelWebpage: { id: 'w1' } });
    assert.strictEqual(parsed.webSearchEnabled, false);
    assert.strictEqual(parsed.memoryWriteEnabled, false);
    assert.deepStrictEqual(parsed.sidePanelWebpage, { id: 'w1' });
});

test('the session is checked before the body', async () => {
    const res = await post({ webSearchEnabled: 'no' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('an empty turn still answers as before', async () => {
    const res = await post({ attachments: [] });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.body, { error: 'Message or attachments required' });
});
