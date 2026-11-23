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
mountSideRoutes(router, { needs: async (userId) => { asked.push(userId); return [/** @type {any} */ ({ kind: 'review', itemId: 'cw-1', title: 'T', runId: 'r1', since: null, reason: 'Look', plan: null })]; }, dailyMail });
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
