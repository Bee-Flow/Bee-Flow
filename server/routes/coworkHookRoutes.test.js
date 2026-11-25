// @typecheck
/**
 * The webhook address of a cowork (./coworkHookRoutes.js): the bearer token is the credential, an unknown or missing
 * one is the same 404, and a valid call answers 202 and starts the item with the JSON it sent. The store and the start
 * are handed in.
 *
 * Run: cd server && node --test routes/coworkHookRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');
const { serve } = require('../testUtils/routeHarness');
const { mountHookRoutes } = require('./coworkHookRoutes');

const TOKEN = 'a-good-token-of-more-than-twenty-characters';
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
/** @type {any[]} */
const started = [];
const router = express.Router();
mountHookRoutes(router, {
    findByHookHash: async (hash) => (hash === HASH ? /** @type {any} */ ({ id: 'w1', userId: 'u1', isActive: true }) : null),
    start: async (item, event) => { started.push([item.id, event]); return true; },
});
const api = serve('/api/cowork', router, { user: null });
after(api.close);

test('a valid token starts the item with what was sent, and answers at once', async () => {
    const res = await api.call('POST', '/api/cowork/hooks', { body: { order: 42 }, headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepStrictEqual([res.status, res.body], [202, { accepted: true }]);
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.strictEqual(started.length, 1);
    assert.deepStrictEqual([started[0][0], started[0][1].kind, started[0][1].data], ['w1', 'webhook', { body: { order: 42 } }]);
});

test('no token, a short one, an unknown one: the same 404, and nothing starts', async () => {
    started.length = 0;
    for (const headers of [{}, { authorization: 'Bearer short' }, { authorization: `Bearer ${TOKEN}x` }, { authorization: TOKEN }]) {
        const res = await api.call('POST', '/api/cowork/hooks', { body: { a: 1 }, headers });
        assert.strictEqual(res.status, 404, JSON.stringify(headers));
    }
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.strictEqual(started.length, 0);
});
