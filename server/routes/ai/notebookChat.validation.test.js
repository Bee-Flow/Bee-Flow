/**
 * What a notebook chat turn may carry (routes/ai/notebookChat.js) — the chat
 * engine's bag, typed and not closed (routes/ai/directChat/turnSchema.js).
 * A `documentContent` that is not text reached the prompt as
 * "[object Object]"; a `history` that is not a list reached `.map`.
 *
 * Run: cd server && node --test routes/ai/notebookChat.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/ai', () => require('./notebookChat'));
const post = (body, user) => api.call('POST', '/ai/chat/notebook/stream', { body, user });

test('the keys the turn reads have the types it assumes', async () => {
    h.assertRefused(assert, await post({ message: 'hi', notebookId: 'nb1', documentContent: { html: 'x' } }), 'body.documentContent', /documentContent is text/);
    h.assertRefused(assert, await post({ message: 'hi', notebookId: 'nb1', history: {} }), 'body.history', /history is a list/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await post({ history: {} }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a turn without a notebook still answers as before', async () => {
    const res = await post({ message: 'hi' });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.body, { error: 'Notebook ID required' });
});
