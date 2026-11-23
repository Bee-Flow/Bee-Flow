// @typecheck
/**
 * The plan routes of /api/cowork (./coworkPlanRoutes.js): each one checks the item is the caller's before anything
 * else, reads its body through a strict schema, and hands the use case the item and what was asked. The item loader
 * and the use case are handed in (the use case has its own tests, usecases/coworkPlan.test.js), so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkPlanRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountPlanRoutes } = require('./coworkPlanRoutes');
const { HttpError } = require('../core/http/errors');

const FINGERPRINT = 'a'.repeat(64);
const STATE = { automationId: 'auto-1', draft: null, approved: null, widens: [], upToDate: false };
const OWNER = { id: 'u1' };

/** @type {Array<[string, Record<string, unknown>]>} */
let asked = [];
const plan = {
    planStateOf: async (item) => { asked.push(['planStateOf', { item: item.id }]); return STATE; },
    attachPlan: async ({ item, automationId }) => { asked.push(['attachPlan', { item: item.id, automationId }]); return STATE; },
    approvePlan: async ({ item, fingerprint }) => { asked.push(['approvePlan', { item: item.id, fingerprint }]); return STATE; },
    removePlan: async ({ item }) => { asked.push(['removePlan', { item: item.id }]); return STATE; },
};
/** The ownership rule of usecases/coworkItems.mts, over one item that belongs to u1. */
const loadItem = async (id, userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId, triggerKind: 'schedule', planAutomationId: 'auto-1', planId: null });
};

const router = express.Router();
// The session check routes/cowork.js puts in front of every Cowork route.
router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
mountPlanRoutes(router, { loadItem, plan: () => plan });
const api = serve('/api/cowork', router, { user: OWNER });
after(api.close);

const ROUTES = /** @type {Array<[string, string, unknown]>} */ ([
    ['GET', '/api/cowork/cw-1/plan', undefined],
    ['PUT', '/api/cowork/cw-1/plan', { automationId: 'auto-1' }],
    ['POST', '/api/cowork/cw-1/plan/approve', { fingerprint: FINGERPRINT }],
    ['DELETE', '/api/cowork/cw-1/plan', undefined],
]);

test('each plan route hands the use case the item and what was asked, and answers with the plan', async () => {
    asked = [];
    for (const [method, url, body] of ROUTES) {
        const res = await api.call(method, url, { body });
        assert.deepStrictEqual([res.status, res.body], [200, STATE], `${method} ${url}`);
    }
    assert.deepStrictEqual(asked, [
        ['planStateOf', { item: 'cw-1' }],
        ['attachPlan', { item: 'cw-1', automationId: 'auto-1' }],
        ['approvePlan', { item: 'cw-1', fingerprint: FINGERPRINT }],
        ['removePlan', { item: 'cw-1' }],
    ]);
});

test('a plan is its owner\'s: no session is 401, another person 403, an unknown item 404, and the use case is never reached', async () => {
    asked = [];
    for (const [method, url, body] of ROUTES) {
        assert.strictEqual((await api.call(method, url, { body, user: null })).status, 401, `${method} ${url} without a session`);
        assert.strictEqual((await api.call(method, url, { body, user: { id: 'someone-else' } })).status, 403, `${method} ${url} as another person`);
        assert.strictEqual((await api.call(method, url.replace('cw-1', 'cw-9'), { body })).status, 404, `${method} ${url} for an unknown item`);
    }
    assert.deepStrictEqual(asked, []);
});

test('naming an automation takes its id as text and nothing else', async () => {
    asked = [];
    for (const body of [{}, { automationId: '' }, { automationId: '   ' }, { automationId: 7 }, { automationId: 'x'.repeat(201) }, { automationId: 'auto-1', extra: true }]) {
        assert.strictEqual((await api.call('PUT', '/api/cowork/cw-1/plan', { body })).status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(asked, []);
    assert.strictEqual((await api.call('PUT', '/api/cowork/cw-1/plan', { body: { automationId: '  auto-1  ' } })).status, 200);
    assert.deepStrictEqual(asked, [['attachPlan', { item: 'cw-1', automationId: 'auto-1' }]], 'spaces around the id are dropped');
});

test('approving takes the fingerprint of the plan that was looked at: 64 characters, nothing else', async () => {
    asked = [];
    for (const body of [{}, { fingerprint: 'abc' }, { fingerprint: 'a'.repeat(65) }, { fingerprint: 12 }, { fingerprint: FINGERPRINT, force: true }]) {
        assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/plan/approve', { body })).status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(asked, []);
});

test('taking a plan off takes no body', async () => {
    asked = [];
    assert.strictEqual((await api.call('DELETE', '/api/cowork/cw-1/plan', { body: { everything: true } })).status, 400);
    assert.deepStrictEqual(asked, []);
});

test('what the use case refuses reaches the caller with its status, its code and its sentence', async () => {
    const refusing = express.Router();
    mountPlanRoutes(refusing, { loadItem, plan: () => ({ ...plan, approvePlan: async () => { throw new HttpError(409, 'cowork_plan_changed', 'The plan changed since you looked at it.'); } }) });
    const other = serve('/api/cowork', refusing, { user: OWNER });
    try {
        const res = await other.call('POST', '/api/cowork/cw-1/plan/approve', { body: { fingerprint: FINGERPRINT } });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, 'cowork_plan_changed');
        assert.match(res.body.error, /changed since you looked/);
    } finally {
        await other.close();
    }
});
