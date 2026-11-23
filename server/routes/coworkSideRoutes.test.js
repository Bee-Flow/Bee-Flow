// @typecheck
/**
 * The routes of /api/cowork about no single item (./coworkSideRoutes.js): "Needs you" answers the caller's own list.
 * The list is handed in (usecases/coworkNeedsYou.test.js has its own tests), so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkSideRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountSideRoutes } = require('./coworkSideRoutes');

/** @type {string[]} */
const asked = [];
const router = express.Router();
router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
/** @type {Map<string, { enabled: boolean, timeZone: string }>} */
const settings = new Map();
const dailyMail = {
    store: {
        getSetting: async (/** @type {string} */ id) => settings.get(id) ?? { enabled: false, timeZone: 'UTC' },
        setSetting: async (/** @type {string} */ id, /** @type {{ enabled: boolean, timeZone: string }} */ s) => { settings.set(id, s); return s; },
    },
    mailAvailable: async () => true,
};
/** @type {any[]} */
const homes = [];
const home = async (/** @type {string} */ userId, /** @type {any} */ day) => { homes.push([userId, day]); return { how: {}, today: [], cost: null }; };
/** @type {{ readOnly: boolean }} */
const policy = { readOnly: false };
mountSideRoutes(router, { home, policyOf: async () => policy, needs: async (userId) => { asked.push(userId); return [/** @type {any} */ ({ kind: 'review', itemId: 'cw-1', title: 'T', runId: 'r1', since: null, reason: 'Look', plan: null })]; }, dailyMail });
// An item route after it, as in routes/cowork.js: the word is never read as an item id.
router.get('/:id', (req, res) => { res.json({ item: req.params.id }); });
const api = serve('/api/cowork', router, { user: { id: 'u1' } });
after(api.close);

test('"Needs you" is the caller\'s own list, with its count, and is never read as an item', async () => {
    const res = await api.call('GET', '/api/cowork/needs-you');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual([res.body.count, res.body.needs[0].kind], [1, 'review']);
    assert.deepStrictEqual(asked, ['u1']);
    assert.strictEqual((await api.call('GET', '/api/cowork/needs-you', { user: null })).status, 401);
    assert.deepStrictEqual((await api.call('GET', '/api/cowork/cw-1')).body, { item: 'cw-1' });
});

test('the daily mail is the caller\'s own setting: off at first, then as saved; an unknown time zone is refused', async () => {
    assert.deepStrictEqual((await api.call('GET', '/api/cowork/daily-mail')).body, { enabled: false, timeZone: 'UTC', available: true });
    const saved = await api.call('PUT', '/api/cowork/daily-mail', { body: { enabled: true, timeZone: 'Europe/Amsterdam' } });
    assert.deepStrictEqual([saved.status, saved.body], [200, { enabled: true, timeZone: 'Europe/Amsterdam', available: true }]);
    assert.deepStrictEqual([...settings.keys()], ['u1']);
    assert.strictEqual((await api.call('PUT', '/api/cowork/daily-mail', { body: { enabled: true, timeZone: 'Mars/Olympus' } })).status, 400);
    assert.strictEqual((await api.call('PUT', '/api/cowork/daily-mail', { body: { enabled: true, timeZone: 'UTC', to: 'x@example.test' } })).status, 400);
});

test('the home is read for the caller\'s own day; a day that is not two ISO times at most two days apart is refused', async () => {
    const day = { from: '2026-11-22T23:00:00.000Z', to: '2026-11-23T23:00:00.000Z' };
    const res = await api.call('GET', `/api/cowork/home?from=${encodeURIComponent(day.from)}&to=${encodeURIComponent(day.to)}`);
    assert.deepStrictEqual([res.status, homes], [200, [['u1', day]]]);
    for (const q of ['', 'from=yesterday&to=today', `from=${encodeURIComponent(day.to)}&to=${encodeURIComponent(day.from)}`, 'from=2026-11-01T00:00:00Z&to=2026-11-23T00:00:00Z']) {
        assert.strictEqual((await api.call('GET', `/api/cowork/home?${q}`)).status, 400, q);
    }
});

test('while the organisation has made Cowork read-only, every change is refused; reading, the policy and the daily mail stay open', async () => {
    router.post('/:id/toggle', (req, res) => { res.json({ toggled: req.params.id }); });
    policy.readOnly = true;
    try {
        const refused = await api.call('POST', '/api/cowork/cw-1/toggle');
        assert.deepStrictEqual([refused.status, refused.body.code], [423, 'cowork_read_only']);
        assert.strictEqual((await api.call('GET', '/api/cowork/cw-1')).status, 200);
        assert.strictEqual((await api.call('PUT', '/api/cowork/daily-mail', { body: { enabled: false, timeZone: 'UTC' } })).status, 200);
    } finally {
        policy.readOnly = false;
    }
    assert.deepStrictEqual((await api.call('POST', '/api/cowork/cw-1/toggle')).body, { toggled: 'cw-1' });
});
