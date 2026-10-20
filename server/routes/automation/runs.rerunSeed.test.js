'use strict';

/**
 * Re-run a step with the inputs of a chosen run, at the route.
 *
 * POST /:id/steps/:stepId/run takes seedRunId, allowLiveUpstream and
 * confirmSideEffects and hands them to runPartial; the plan it answers with
 * rides beside the run, not inside the stored row. GET
 * /:id/steps/:stepId/rerun-plan answers the same plan without running anything.
 * Both are an editor's tool. The 404 / 409 refusals are thrown by the runner
 * (core/automationRunner.partial.seedRun.test.js) and must reach the client
 * untouched.
 *
 * Route handlers invoked directly, with the same require.cache Module mock +
 * findHandler technique as runs.triggerStepId.test.js.
 *
 * Run: node --test routes/automation/runs.rerunSeed.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const { HttpError } = require('../../core/http/errors');

let AUTOMATIONS = {};
const calls = { partial: [], plan: [] };
let partialImpl = null;
let planImpl = null;

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    getRunSteps: async () => [{ stepId: 's1', status: 'success' }],
    listSharesForAutomation: async () => [],
});
mock(path.join(SERVER, 'core/automationRunner'), {
    runPartial: async (a, stepId, opts) => { calls.partial.push({ id: a.id, stepId, ...opts }); return partialImpl(); },
    planPartialRun: async (a, stepId, opts) => { calls.plan.push({ id: a.id, stepId, ...opts }); return planImpl(); },
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

const router = require('./runs');

function findHandler(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const stepRunHandler = findHandler('post', '/:id/steps/:stepId/run');
const planHandler = findHandler('get', '/:id/steps/:stepId/rerun-plan');

const DEF = { trigger: { id: 'trg', kind: 'manual' }, steps: [{ id: 's1', type: 'set', fields: {} }], edges: [{ from: 'trg', to: 's1' }] };
const PLAN = { seedRunId: 'r1', seedRunVersion: 1, seedRunStartedAt: null, willExecute: ['s1'], missingUpstream: [], sideEffects: [], requiresConfirm: false, replayStale: [] };
const owner = { id: 'user1' };
const postReq = (body) => ({ params: { id: 'a1', stepId: 's1' }, session: { user: owner }, body });
const getReq = (query, user = owner) => ({ params: { id: 'a1', stepId: 's1' }, session: { user }, query });

test('POST forwards the seed options and puts the plan beside the run, not in it', async () => {
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    calls.partial.length = 0;
    partialImpl = () => ({ id: 'run-1', status: 'success', rerunPlan: PLAN });
    const res = makeRes();
    await stepRunHandler(postReq({ mode: 'only', seedRunId: 'r1', allowLiveUpstream: true, confirmSideEffects: true }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls.partial[0].seedRunId, 'r1');
    assert.strictEqual(calls.partial[0].allowLiveUpstream, true);
    assert.strictEqual(calls.partial[0].confirmSideEffects, true);
    assert.deepStrictEqual(res.body.run, { id: 'run-1', status: 'success' });
    assert.deepStrictEqual(res.body.rerunPlan, PLAN);
    assert.strictEqual(res.body.stepRecord.stepId, 's1');
});

test('POST without a seed run passes nothing on and answers the old shape', async () => {
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    calls.partial.length = 0;
    partialImpl = () => ({ id: 'run-2', status: 'success' });
    const res = makeRes();
    await stepRunHandler(postReq({ mode: 'only' }), res);
    assert.strictEqual(calls.partial[0].seedRunId, null);
    assert.strictEqual(calls.partial[0].allowLiveUpstream, false);
    assert.strictEqual(calls.partial[0].confirmSideEffects, false);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['run', 'stepRecord', 'steps']);
});

test('the runner\'s 404 and 409 reach the client as they are', async () => {
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    partialImpl = () => { throw new HttpError(409, 'side_effects_need_confirm', 'confirm', { steps: [{ stepId: 's1' }] }); };
    await assert.rejects(stepRunHandler(postReq({ mode: 'only', seedRunId: 'r1' }), makeRes()), (e) => {
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.code, 'side_effects_need_confirm');
        assert.deepStrictEqual(e.details, { steps: [{ stepId: 's1' }] });
        return true;
    });
});

test('GET rerun-plan answers the plan and executes nothing', async () => {
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    calls.plan.length = 0; calls.partial.length = 0;
    planImpl = () => PLAN;
    const res = makeRes();
    await planHandler(getReq({ seedRunId: 'r1', mode: 'from' }), res);
    assert.deepStrictEqual(res.body, { rerunPlan: PLAN });
    assert.strictEqual(calls.plan[0].seedRunId, 'r1');
    assert.strictEqual(calls.plan[0].mode, 'from');
    assert.strictEqual(calls.plan[0].startedByUserId, 'user1');
    assert.strictEqual(calls.partial.length, 0);
});

test('GET rerun-plan is an editor\'s tool: a stranger gets 403, an unknown automation 404', async () => {
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    calls.plan.length = 0;
    const denied = makeRes();
    await planHandler(getReq({ seedRunId: 'r1', mode: 'only' }, { id: 'stranger' }), denied);
    assert.strictEqual(denied.statusCode, 403);
    assert.strictEqual(calls.plan.length, 0);
    const missing = makeRes();
    await planHandler({ ...getReq({ seedRunId: 'r1', mode: 'only' }), params: { id: 'nope', stepId: 's1' } }, missing);
    assert.strictEqual(missing.statusCode, 404);
});

test('GET rerun-plan: an unknown trigger is a 400, an unknown step a 404', async () => {
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: DEF } };
    const bad = makeRes();
    await planHandler(getReq({ seedRunId: 'r1', mode: 'only', triggerStepId: 'trig_nope' }), bad);
    assert.strictEqual(bad.statusCode, 400);
    planImpl = () => { throw new Error('runPartial: step zz not found in definition'); };
    await assert.rejects(planHandler(getReq({ seedRunId: 'r1', mode: 'only' }), makeRes()), (e) => {
        assert.strictEqual(e.status, 404);
        assert.strictEqual(e.code, 'step_not_found');
        return true;
    });
});

test('the body and query schemas accept the new fields and refuse a stray one', () => {
    const { PartialRunBody, RerunPlanQuery } = require('./runSchemas');
    assert.ok(PartialRunBody.safeParse({ mode: 'from', seedRunId: 'r1', allowLiveUpstream: false, confirmSideEffects: true }).success);
    assert.ok(PartialRunBody.safeParse({ seedRunId: 5 }).success === false);
    assert.ok(PartialRunBody.safeParse({ confirmSideEffects: 'yes' }).success === false);
    assert.ok(PartialRunBody.safeParse({ seedRun: 'r1' }).success === false);
    assert.ok(PartialRunBody.safeParse({}).success, 'a body without any of them is the old call');
    assert.strictEqual(RerunPlanQuery.parse({ seedRunId: 'r1' }).mode, 'only');
    assert.ok(RerunPlanQuery.safeParse({}).success === false, 'seedRunId is required');
    assert.ok(RerunPlanQuery.safeParse({ seedRunId: 'r1', mode: 'upTo' }).success === false);
});
