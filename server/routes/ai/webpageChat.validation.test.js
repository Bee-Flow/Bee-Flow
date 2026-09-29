/**
 * What a webpage builder turn may carry (routes/ai/webpageChat.js) — the chat
 * engine's bag, typed and not closed (routes/ai/directChat/turnSchema.js).
 *
 * `chatMode` fell back to `auto` for anything it did not know, so a typo in
 * `plan` (propose, change nothing) made the builder edit the page at once.
 *
 * Run: cd server && node --test routes/ai/webpageChat.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/ai', () => require('./webpageChat'));
const post = (body, user) => api.call('POST', '/ai/chat/webpage/stream', { body, user });

test('a chat mode the builder does not have is refused, not run as auto', async () => {
    h.assertRefused(assert, await post({ message: 'hi', webpageId: 'w1', chatMode: 'plna' }), 'body.chatMode', /ask, auto or plan/);
    h.assertRefused(assert, await post({ message: 'hi', webpageId: 'w1', htmlContent: ['<p>'] }), 'body.htmlContent', /htmlContent is text/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await post({ chatMode: 'plna' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});
