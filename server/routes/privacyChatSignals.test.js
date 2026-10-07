/**
 * routes/privacyChatSignals.js: the caller's own "Don't count my chat turns".
 *
 * Pinned, through a real express app, the real route and the real objection
 * store (its queries answered by a recorded database, core/http/routeHarness):
 *
 *   - no session, no answer (401) and no query;
 *   - GET and PUT round-trip, for the caller only: the user id is the
 *     session's, it is never read from the request and never written back;
 *   - a query on either route, an unknown body key or a non-boolean is a 400
 *     that never reaches the store;
 *   - the response is `{ counted }` and nothing else, never cached;
 *   - a read error reads as "not counted" (when in doubt, do not count), and
 *     a failed write is a 500 with a correlation id, not a silent success.
 *
 * Run: cd server && node --test routes/privacyChatSignals.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../core/http/routeHarness');

/** The chat_signal_objections table, as the recorded database keeps it. */
const objecting = new Set();
const fail = { read: false, write: false };
function answer(sql, params) {
    const write = /^\s*(INSERT|DELETE)/i.test(sql);
    if (!/chat_signal_objections/.test(sql) || /^\s*CREATE/i.test(sql)) return undefined;
    if (write && fail.write) throw Object.assign(new Error('write failed'), { code: 'ECONNRESET' });
    if (!write && fail.read) throw Object.assign(new Error('read failed'), { code: 'ECONNRESET' });
    if (/^\s*INSERT/i.test(sql)) { objecting.add(params[0]); return { rows: [] }; }
    if (/^\s*DELETE/i.test(sql)) { objecting.delete(params[0]); return { rows: [] }; }
    return { rows: objecting.has(params[0]) ? [{ one: 1 }] : [] };
}

const { db, api } = h.routeUnderTest(test, '/api/privacy/chat-signals', () => require('./privacyChatSignals'), { answer });
const URL_ = '/api/privacy/chat-signals/preference';
const ADA = { id: 'u-ada', organizationId: 'org-1', role: 'user', email: 'ada@example.org' };
const BOB = { id: 'u-bob', organizationId: 'org-1', role: 'user', email: 'bob@example.org' };
// Never read before the failure test: the store memoises an answer for 30 s.
const CAROL = { id: 'u-carol', organizationId: 'org-1', role: 'user', email: 'carol@example.org' };

test.beforeEach(() => { objecting.clear(); fail.read = false; fail.write = false; });

test('no session: 401, and nothing is read', async () => {
    assert.equal((await api.call('GET', URL_, { user: null })).status, 401);
    assert.equal((await api.call('PUT', URL_, { user: null, body: { counted: false } })).status, 401);
    assert.deepEqual(db.queries, []);
});

test('GET and PUT round-trip for the caller only, and the answer is { counted } alone', async () => {
    const first = await api.call('GET', URL_, { user: ADA });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { counted: true });
    assert.equal(first.headers.get('cache-control'), 'no-store');

    const off = await api.call('PUT', URL_, { user: ADA, body: { counted: false } });
    assert.deepEqual([off.status, off.body], [200, { counted: false }]);
    assert.deepEqual([...objecting], ['u-ada'], 'the session\'s user, nobody else');
    assert.deepEqual((await api.call('GET', URL_, { user: ADA })).body, { counted: false });
    assert.deepEqual((await api.call('GET', URL_, { user: BOB })).body, { counted: true }, 'another person is untouched');

    const on = await api.call('PUT', URL_, { user: ADA, body: { counted: true } });
    assert.deepEqual(on.body, { counted: true });
    assert.deepEqual([...objecting], []);
    assert.deepEqual((await api.call('GET', URL_, { user: ADA })).body, { counted: true });

    for (const res of [first, off, on]) {
        assert.ok(!res.text.includes('u-ada') && !res.text.includes('ada@'), 'no id or address in the answer');
    }
});

test('a query, an unknown key or a non-boolean is refused before the store', async () => {
    h.assertRefused(assert, await api.call('GET', `${URL_}?userId=u-bob`, { user: ADA }), null, /always your own/);
    h.assertRefused(assert, await api.call('PUT', `${URL_}?userId=u-bob`, { user: ADA, body: { counted: false } }), null, /always your own/);
    h.assertRefused(assert, await api.call('PUT', URL_, { user: ADA, body: { counted: false, userId: 'u-bob' } }), null, /no other keys/);
    h.assertRefused(assert, await api.call('PUT', URL_, { user: ADA, body: { counted: 'no' } }), 'body.counted', /true or false/);
    h.assertRefused(assert, await api.call('PUT', URL_, { user: ADA, body: {} }), 'body.counted', /true or false/);
    assert.deepEqual(db.queries, []);
    assert.deepEqual([...objecting], []);
});

test('a read error reads as not counted; a failed write is a 500 with a correlation id', async () => {
    fail.read = true;
    assert.deepEqual((await api.call('GET', URL_, { user: CAROL })).body, { counted: false }, 'when in doubt, do not count');

    fail.write = true;
    const res = await api.call('PUT', URL_, { user: CAROL, body: { counted: false } });
    assert.equal(res.status, 500);
    assert.ok(res.body.correlationId, 'the terminal handler answered');
    assert.ok(!res.text.includes('write failed'), 'no driver text');
});
