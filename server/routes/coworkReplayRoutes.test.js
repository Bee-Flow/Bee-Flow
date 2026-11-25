// @typecheck
/**
 * The replay routes of /api/cowork (./coworkReplayRoutes.js): the item is the caller's before anything else, the body
 * is `{}` or `{ limit }` and nothing more, and the use case gets the item and what was asked. The item loader and the
 * use case are handed in (the use case has its own tests, usecases/coworkReplay.test.js), so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkReplayRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountReplayRoutes } = require('./coworkReplayRoutes');
const { HttpError } = require('../core/http/errors');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

const STARTED = { replayId: 'rp-1', fingerprint: 'a'.repeat(64), total: 3 };
const STATE = { replayId: 'rp-1', status: 'running', done: false, fingerprint: 'a'.repeat(64), total: 3, same: 1, differs: 0, partial: 0, notReplayable: 0, runs: [] };

/** @type {Array<[string, Record<string, unknown>]>} */
let asked = [];
const replay = {
    startReplay: async ({ item, limit }) => { asked.push(['startReplay', { item: item.id, limit }]); return STARTED; },
    replayStateOf: async ({ item, replayId }) => { asked.push(['replayStateOf', { item: item.id, replayId }]); return STATE; },
};
const loadItem = async (/** @type {string} */ id, /** @type {string} */ userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId, planAutomationId: 'auto-1' });
};

const router = express.Router();
router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
mountReplayRoutes(router, { loadItem, replay: () => /** @type {any} */ (replay), replayLimit: perUserRateLimit({ windowMs: 60_000, max: 1000, name: 'cowork-plan-replay-roomy', _redis: null }) });
const api = serve('/api/cowork', router, { user: { id: 'u1' } });
after(api.close);

test('starting a replay answers 202 at once; reading it answers how it is going', async () => {
    asked = [];
    const started = await api.call('POST', '/api/cowork/cw-1/plan/replay');
    assert.deepStrictEqual([started.status, started.body], [202, STARTED]);
    const limited = await api.call('POST', '/api/cowork/cw-1/plan/replay', { body: { limit: 5 } });
    assert.strictEqual(limited.status, 202);
    const read = await api.call('GET', '/api/cowork/cw-1/plan/replay/rp-1');
    assert.deepStrictEqual([read.status, read.body], [200, STATE]);
    assert.deepStrictEqual(asked, [['startReplay', { item: 'cw-1', limit: undefined }], ['startReplay', { item: 'cw-1', limit: 5 }], ['replayStateOf', { item: 'cw-1', replayId: 'rp-1' }]]);
});

test('a replay is its owner\'s: no session 401, another person 403, an unknown item 404, and the use case is never reached', async () => {
    asked = [];
    for (const [method, url] of [['POST', '/api/cowork/cw-1/plan/replay'], ['GET', '/api/cowork/cw-1/plan/replay/rp-1']]) {
        assert.strictEqual((await api.call(method, url, { user: null })).status, 401);
        assert.strictEqual((await api.call(method, url, { user: { id: 'someone-else' } })).status, 403);
        assert.strictEqual((await api.call(method, url.replace('cw-1', 'cw-9'))).status, 404);
    }
    assert.deepStrictEqual(asked, []);
});

test('the body is {} or a limit from 1 to 50, nothing else', async () => {
    asked = [];
    for (const body of [{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: 'all' }, { everything: true }]) {
        assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/plan/replay', { body })).status, 400, JSON.stringify(body));
    }
    assert.strictEqual((await api.call('GET', `/api/cowork/cw-1/plan/replay/${'x'.repeat(201)}`)).status, 400);
    assert.deepStrictEqual(asked, []);
});
