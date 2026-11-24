// @typecheck
/**
 * The goal routes of /api/cowork (./coworkGoalRoutes.js): each one checks the item is the caller's, reads its body
 * through a strict schema, and hands the use case the item and what was asked. The item loader and the use case are
 * handed in (the use case has its own tests, usecases/coworkGoals.test.js), so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkGoalRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve } = require('../testUtils/routeHarness');
const { mountGoalRoutes } = require('./coworkGoalRoutes');
const { HttpError } = require('../core/http/errors');

const FINGERPRINT = 'b'.repeat(64);
const ANSWER = { goal: null };

/** @type {Array<[string, Record<string, unknown>]>} */
let asked = [];
const goals = {
    goalOf: async (/** @type {any} */ item) => { asked.push(['goalOf', { item: item.id }]); return ANSWER; },
    saveGoal: async (/** @type {any} */ { item, sentence, targetPercent }) => { asked.push(['saveGoal', { item: item.id, sentence, targetPercent }]); return ANSWER; },
    draftCheck: async (/** @type {any} */ { item, userOrgId, signal }) => { asked.push(['draftCheck', { item: item.id, userOrgId, signal: signal instanceof AbortSignal }]); return { summary: 'Counts.', ...ANSWER }; },
    approveCheck: async (/** @type {any} */ { item, fingerprint }) => { asked.push(['approveCheck', { item: item.id, fingerprint }]); return ANSWER; },
    removeGoal: async (/** @type {any} */ { item }) => { asked.push(['removeGoal', { item: item.id }]); return ANSWER; },
};
const loadItem = async (/** @type {string} */ id, /** @type {string} */ userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId });
};
/** @type {import('express').RequestHandler<{ id: string }>} */
const pass = (_req, _res, next) => next();

const router = express.Router();
router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
mountGoalRoutes(router, { loadItem, goals: () => /** @type {any} */ (goals), orgOf: async () => 'org-1', draftLimit: pass, moduleGate: pass });
const api = serve('/api/cowork', router, { user: { id: 'u1' } });
after(api.close);

const ROUTES = /** @type {Array<[string, string, unknown]>} */ ([
    ['GET', '/api/cowork/cw-1/goal', undefined],
    ['PUT', '/api/cowork/cw-1/goal', { sentence: '  Every mail gets an answer within two working days ', targetPercent: 95 }],
    ['POST', '/api/cowork/cw-1/goal/check', undefined],
    ['POST', '/api/cowork/cw-1/goal/approve', { fingerprint: FINGERPRINT }],
    ['DELETE', '/api/cowork/cw-1/goal', undefined],
]);

test('each goal route hands the use case the item and what was asked', async () => {
    asked = [];
    for (const [method, url, body] of ROUTES) assert.strictEqual((await api.call(method, url, { body })).status, 200, `${method} ${url}`);
    assert.deepStrictEqual(asked, [
        ['goalOf', { item: 'cw-1' }],
        ['saveGoal', { item: 'cw-1', sentence: 'Every mail gets an answer within two working days', targetPercent: 95 }],
        ['draftCheck', { item: 'cw-1', userOrgId: 'org-1', signal: true }],
        ['approveCheck', { item: 'cw-1', fingerprint: FINGERPRINT }],
        ['removeGoal', { item: 'cw-1' }],
    ]);
});

test('a goal is its owner\'s: no session 401, another person 403, an unknown item 404, the use case never reached', async () => {
    asked = [];
    for (const [method, url, body] of ROUTES) {
        assert.strictEqual((await api.call(method, url, { body, user: null })).status, 401);
        assert.strictEqual((await api.call(method, url, { body, user: { id: 'someone-else' } })).status, 403);
        assert.strictEqual((await api.call(method, url.replace('cw-1', 'cw-9'), { body })).status, 404);
    }
    assert.deepStrictEqual(asked, []);
});

test('a goal is one sentence and a whole percentage; approving takes a fingerprint and nothing else', async () => {
    asked = [];
    for (const body of [{}, { sentence: '' }, { sentence: 'x'.repeat(501) }, { sentence: 'ok', targetPercent: 0 }, { sentence: 'ok', targetPercent: 101 }, { sentence: 'ok', targetPercent: 50.5 }, { sentence: 'ok', extra: 1 }]) {
        assert.strictEqual((await api.call('PUT', '/api/cowork/cw-1/goal', { body })).status, 400, JSON.stringify(body));
    }
    for (const body of [{}, { fingerprint: 'abc' }, { fingerprint: FINGERPRINT, force: true }]) {
        assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/goal/approve', { body })).status, 400, JSON.stringify(body));
    }
    assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/goal/check', { body: { everything: true } })).status, 400);
    assert.deepStrictEqual(asked, []);
    assert.strictEqual((await api.call('PUT', '/api/cowork/cw-1/goal', { body: { sentence: 'A goal' } })).status, 200);
    assert.deepStrictEqual(asked, [['saveGoal', { item: 'cw-1', sentence: 'A goal', targetPercent: 100 }]], 'the target is 100 when none is given');
});
