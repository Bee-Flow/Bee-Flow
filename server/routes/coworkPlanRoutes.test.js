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

const { serve, limitersOn } = require('../testUtils/routeHarness');
const { mountPlanRoutes } = require('./coworkPlanRoutes');
const { HttpError } = require('../core/http/errors');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

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
const TRY_STATE = { tryId: 'try-1', status: 'running', done: false, summary: null, error: null, durationMs: null, steps: [] };
const tryOut = {
    startTry: async ({ item }) => { asked.push(['startTry', { item: item.id }]); return { tryId: 'try-1', fingerprint: FINGERPRINT }; },
    tryStateOf: async ({ item, tryId }) => { asked.push(['tryStateOf', { item: item.id, tryId }]); return TRY_STATE; },
};
const TRACE = { runId: 'run-1', planVersion: 2, recorded: true, done: true, durationMs: 5200, steps: [] };
const trace = { runTraceOf: async ({ item, runId }) => { asked.push(['runTraceOf', { item: item.id, runId }]); return TRACE; } };
/** A limit no test reaches by accident; the limit itself has its own router below. */
const roomy = () => perUserRateLimit({ windowMs: 60_000, max: 1000, name: 'cowork-plan-try-roomy', _redis: null });
/** The ownership rule of usecases/coworkItems.mts, over one item that belongs to u1. */
const loadItem = async (id, userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId, triggerKind: 'schedule', planAutomationId: 'auto-1', planId: null });
};

const router = express.Router();
// The session check routes/cowork.js puts in front of every Cowork route.
router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
mountPlanRoutes(router, { loadItem, plan: () => plan, tryOut: () => tryOut, trace: () => trace, tryLimit: roomy() });
const api = serve('/api/cowork', router, { user: OWNER });
after(api.close);

const TRY_ROUTES = /** @type {Array<[string, string, unknown]>} */ ([
    ['POST', '/api/cowork/cw-1/plan/try', undefined],
    ['GET', '/api/cowork/cw-1/plan/try/try-1', undefined],
    ['GET', '/api/cowork/cw-1/runs/run-1/trace', undefined],
]);

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
    for (const [method, url, body] of [...ROUTES, ...TRY_ROUTES]) {
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

test('trying a plan answers 202 with the try-out and the fingerprint that is tried; reading it answers how it is going', async () => {
    asked = [];
    const started = await api.call('POST', '/api/cowork/cw-1/plan/try');
    assert.deepStrictEqual([started.status, started.body], [202, { tryId: 'try-1', fingerprint: FINGERPRINT }]);
    const read = await api.call('GET', '/api/cowork/cw-1/plan/try/try-1');
    assert.deepStrictEqual([read.status, read.body], [200, TRY_STATE]);
    assert.deepStrictEqual(asked, [['startTry', { item: 'cw-1' }], ['tryStateOf', { item: 'cw-1', tryId: 'try-1' }]]);
});

test('the steps of a run are read through its item: the use case gets the item and the run that was asked for', async () => {
    asked = [];
    const res = await api.call('GET', '/api/cowork/cw-1/runs/run-1/trace');
    assert.deepStrictEqual([res.status, res.body], [200, TRACE]);
    assert.deepStrictEqual(asked, [['runTraceOf', { item: 'cw-1', runId: 'run-1' }]]);
    assert.strictEqual((await api.call('GET', `/api/cowork/cw-1/runs/${'x'.repeat(201)}/trace`)).status, 400);
});

test('starting a try-out takes no body, and a try-out id is short text', async () => {
    asked = [];
    assert.strictEqual((await api.call('POST', '/api/cowork/cw-1/plan/try', { body: { live: true } })).status, 400);
    assert.strictEqual((await api.call('GET', `/api/cowork/cw-1/plan/try/${'x'.repeat(201)}`)).status, 400);
    assert.deepStrictEqual(asked, []);
});

test('starting try-outs is limited per person: over the limit is 429 before anything runs, and another person is not held up', async () => {
    asked = [];
    const limited = express.Router();
    mountPlanRoutes(limited, { loadItem, plan: () => plan, tryOut: () => tryOut, tryLimit: perUserRateLimit({ windowMs: 60_000, max: 2, name: 'cowork-plan-try-tight', _redis: null }) });
    const other = serve('/api/cowork', limited, { user: OWNER });
    try {
        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await other.call('POST', '/api/cowork/cw-1/plan/try')).status);
        assert.deepStrictEqual(statuses, [202, 202, 429]);
        assert.strictEqual(asked.length, 2);
        assert.strictEqual((await other.call('POST', '/api/cowork/cw-1/plan/try', { user: { id: 'someone-else' } })).status, 403, 'another person is refused for ownership, not for the limit');
        assert.strictEqual((await other.call('GET', '/api/cowork/cw-1/plan/try/try-1')).status, 200, 'reading is not limited');
    } finally {
        await other.close();
    }
});

test('the try-out limit is a named one, so it holds across replicas', () => {
    const probe = express.Router();
    mountPlanRoutes(probe, { loadItem });
    assert.deepStrictEqual(limitersOn(probe, 'post', '/:id/plan/try'), ['cowork-plan-try']);
    assert.deepStrictEqual(limitersOn(probe, 'get', '/:id/plan/try/:tryId'), []);
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
