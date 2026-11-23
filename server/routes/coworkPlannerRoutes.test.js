// @typecheck
/**
 * The planner route of /api/cowork (./coworkPlannerRoutes.js): ownership and readiness first, as ordinary answers;
 * then a stream of what is being drafted that ends in the plan or in one sentence. The item loader, the planner and
 * the limits are handed in (the planner has its own tests, usecases/coworkPlanner.test.js), so nothing is mocked.
 *
 * Run: cd server && node --test routes/coworkPlannerRoutes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { serve, limitersOn } = require('../testUtils/routeHarness');
const { mountPlannerRoutes } = require('./coworkPlannerRoutes');
const { HttpError } = require('../core/http/errors');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

const OWNER = { id: 'u1' };
const STATE = { automationId: 'auto-new', draft: null, approved: null, widens: [], upToDate: false };
const URL = '/api/cowork/cw-1/plan/make';

/** The ownership rule of usecases/coworkItems.mts, over one item that belongs to u1. */
const loadItem = async (id, userId) => {
    if (id !== 'cw-1') throw new HttpError(404, 'cowork_refused', 'Not found');
    if (userId !== 'u1') throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return /** @type {any} */ ({ id, userId, title: 'Supplier radar', prompt: 'Read the supplier mail.', triggerKind: 'schedule', planAutomationId: null });
};

const pass = (req, res, next) => next();

/**
 * A router with a planner that behaves as told.
 * @param {{ ready?: () => Promise<unknown>, make?: (input: any) => Promise<any>, moduleGate?: import('express').RequestHandler, makeLimit?: import('express').RequestHandler }} [how]
 */
function apiWith({ ready = async () => ({ brief: 'b', modelId: 'm' }), make = async () => ({ automationId: 'auto-new', summary: 'It reads the mail.', findings: [], rounds: 2 }), moduleGate = pass, makeLimit = pass } = {}) {
    const asked = /** @type {Array<[string, Record<string, unknown>]>} */ ([]);
    const router = express.Router();
    router.use((req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })));
    mountPlannerRoutes(router, {
        loadItem, moduleGate, makeLimit,
        orgOf: async () => 'org-1',
        planner: () => ({
            readyToPlan: async ({ item, userOrgId }) => { asked.push(['readyToPlan', { item: item.id, userOrgId }]); return /** @type {any} */ (await ready()); },
            makePlan: async (input) => { asked.push(['makePlan', { item: input.item.id, userOrgId: input.userOrgId, hasSignal: input.signal instanceof AbortSignal, hasSession: !!input.session }]); return make(input); },
        }),
        plan: () => ({ planStateOf: async (item) => { asked.push(['planStateOf', { item: item.id, planAutomationId: item.planAutomationId }]); return /** @type {any} */ (STATE); } }),
    });
    const api = serve('/api/cowork', router, { user: OWNER });
    after(api.close);
    return { api, asked };
}

/** The events of a stream answer, heartbeats left out. @param {string} text */
function eventsOf(text) {
    const out = [];
    for (const block of text.split('\n\n')) {
        const event = block.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
        const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
        if (event && event !== 'ping' && data) out.push([event, JSON.parse(data)]);
    }
    return out;
}

test('making a plan streams what is being drafted and ends in the plan as its owner now sees it', async () => {
    const { api, asked } = apiWith({
        make: async (input) => {
            input.onProgress({ phase: 'thinking', round: 0 });
            input.onProgress({ phase: 'drafted', round: 1, steps: [{ id: 'a', title: 'Get the mail', kind: 'fixed' }] });
            return { automationId: 'auto-new', summary: 'It reads the mail.', findings: [], rounds: 2 };
        },
    });
    const res = await api.call('POST', URL);
    assert.strictEqual(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
    assert.deepStrictEqual(eventsOf(res.text), [
        ['progress', { phase: 'thinking', round: 0 }],
        ['progress', { phase: 'drafted', round: 1, steps: [{ id: 'a', title: 'Get the mail', kind: 'fixed' }] }],
        ['done', { summary: 'It reads the mail.', state: STATE }],
    ]);
    assert.deepStrictEqual(asked, [
        ['readyToPlan', { item: 'cw-1', userOrgId: 'org-1' }],
        ['makePlan', { item: 'cw-1', userOrgId: 'org-1', hasSignal: true, hasSession: true }],
        ['planStateOf', { item: 'cw-1', planAutomationId: 'auto-new' }],
    ]);
});

test('a plan is its owner\'s to make: no session is 401, another person 403, an unknown item 404, and no planner is asked', async () => {
    const { api, asked } = apiWith();
    assert.strictEqual((await api.call('POST', URL, { user: null })).status, 401);
    assert.strictEqual((await api.call('POST', URL, { user: { id: 'someone-else' } })).status, 403);
    assert.strictEqual((await api.call('POST', URL.replace('cw-1', 'cw-9'))).status, 404);
    assert.strictEqual((await api.call('POST', URL, { body: { model: 'the-big-one' } })).status, 400, 'it takes no body');
    assert.deepStrictEqual(asked, []);
});

test('an item that may not get a plan made is an ordinary refusal with its status, not a stream', async () => {
    const { api, asked } = apiWith({ ready: async () => { throw new HttpError(409, 'cowork_plan_refused', 'This item already has a plan. Take it off to make a new one.'); } });
    const res = await api.call('POST', URL);
    assert.deepStrictEqual([res.status, res.body.code], [409, 'cowork_plan_refused']);
    assert.match(res.body.error, /already has a plan/);
    assert.deepStrictEqual(asked.map((a) => a[0]), ['readyToPlan']);
});

test('a making that fails for a reason meant for its owner ends the stream with that sentence', async () => {
    const empty = apiWith({ make: async () => { throw new HttpError(422, 'cowork_planner_empty', 'No plan could be made for this brief. No calendar is connected.'); } });
    assert.deepStrictEqual(eventsOf((await empty.api.call('POST', URL)).text), [['error', { error: 'No plan could be made for this brief. No calendar is connected.', code: 'cowork_planner_empty' }]]);
    const slow = apiWith({ make: async () => { throw new HttpError(504, 'cowork_planner_timeout', 'Making the plan took too long. Try again, or write a shorter brief.'); } });
    assert.deepStrictEqual(eventsOf((await slow.api.call('POST', URL)).text)[0][1].code, 'cowork_planner_timeout');
});

test('any other failure reaches the page as one fixed sentence: never the reason itself', async () => {
    const { api, asked } = apiWith({ make: async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:5432 (password=hunter2)'); } });
    const res = await api.call('POST', URL);
    assert.deepStrictEqual(eventsOf(res.text), [['error', { error: 'The plan could not be made. Try again in a moment.', code: 'cowork_planner_failed' }]]);
    assert.ok(!res.text.includes('hunter2') && !res.text.includes('10.0.0.7'));
    assert.ok(!asked.some((a) => a[0] === 'planStateOf'));
});

test('it stands behind the automation module and a named limit per person, both before the item is even read', async () => {
    const off = apiWith({ moduleGate: (req, res) => { res.status(404).json({ error: 'not_found' }); } });
    assert.strictEqual((await off.api.call('POST', URL)).status, 404);
    assert.deepStrictEqual(off.asked, []);

    const tight = apiWith({ makeLimit: perUserRateLimit({ windowMs: 60_000, max: 1, name: 'cowork-plan-make-tight', _redis: null }) });
    assert.deepStrictEqual([(await tight.api.call('POST', URL)).status, (await tight.api.call('POST', URL)).status], [200, 429]);
    assert.strictEqual(tight.asked.filter((a) => a[0] === 'makePlan').length, 1);

    const real = express.Router();
    mountPlannerRoutes(real, { loadItem });
    assert.deepStrictEqual(limitersOn(real, 'post', '/:id/plan/make'), ['cowork-plan-make']);
});
