'use strict';

/**
 * The run-starting endpoints answer within a cap, and a 202 always names the
 * run (run-watch F1): POST /:id/run, /:id/dry-run and /:id/steps/:stepId/run.
 *
 *   respond: 'created'   202 { accepted, pending, runId } as soon as the run exists
 *   (default)            200 { run, steps } when it ends within the cap
 *   a runner that ends without a run (and never named one) is a 500, not a 202
 *
 * Route handlers invoked directly (same technique as runs.triggerStepId.test.js).
 * Run: node --test routes/automation/runs.respondCreated.test.js
 */
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');
const automationStore = require('../../stores/automationStore');
const runner = require('../../core/automationRunner');

const DEF = { trigger: { id: 'trg', kind: 'manual' }, steps: [{ id: 's1', type: 'set', fields: {} }], edges: [{ from: 'trg', to: 's1' }] };
const AUTOMATION = { id: 'a1', userId: 'user1', definition: DEF, liveVersion: 1 };
const later = (ms) => new Promise((r) => setTimeout(r, ms));
let behaviour = 'slow';
const calls = [];

// A runner that names the run at once and then takes its time (or returns nothing).
async function fakeRun(kind, onRunCreated) {
    const id = `${kind}-${calls.length}`;
    if (behaviour === 'null') return null;
    onRunCreated?.({ id });
    if (behaviour === 'slow') await later(300);
    return { id, status: 'success' };
}

// No module mocking: functions are swapped ON the module objects for the
// duration of the file and put back after (runs.runsTab.test.js does the same).
const { swap, restore } = makeSwaps();
before(() => {
    swap(automationStore, 'getAutomation', async (id) => (id === 'a1' ? { ...AUTOMATION } : null));
    swap(automationStore, 'getRunSteps', async (id) => [{ stepId: 's1', status: 'success', runId: id }]);
    swap(runner, 'executeAutomation', async (a, opts) => { calls.push(opts); return fakeRun(opts.mode === 'dry_run' ? 'dry' : 'run', opts.onRunCreated); });
    swap(runner, 'runPartial', async (a, stepId, opts) => { calls.push(opts); return fakeRun('step', opts.onRunCreated); });
});

const { runRoute: runRouteOf, makeRes } = require('../../testUtils/routeHandlers');
const router = require('./runs');
const runRoute = (method, routePath) => runRouteOf(router, method, routePath);
after(() => { restore(); setImmediate(() => process.exit(process.exitCode || 0)); });

const ROUTES = [
    ['/:id/run', runRoute('post', '/:id/run'), {}],
    ['/:id/dry-run', runRoute('post', '/:id/dry-run'), {}],
    ['/:id/steps/:stepId/run', runRoute('post', '/:id/steps/:stepId/run'), { stepId: 's1' }],
];
const req = (params, body) => ({ params: { id: 'a1', ...params }, query: {}, session: { user: { id: 'user1' } }, body });

test('respond "created": every run route answers 202 with the run id, before the run ends', async () => {
    behaviour = 'slow';
    for (const [name, handler, params] of ROUTES) {
        const started = Date.now();
        const res = await handler(req(params, { respond: 'created' }), makeRes());
        assert.strictEqual(res.statusCode, 202, `${name}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.pending, true, name);
        assert.match(String(res.body.runId), /^(run|dry|step)-\d+$/, `${name} named its run`);
        assert.ok(Date.now() - started < 250, `${name} did not wait for the run`);
        assert.strictEqual(typeof calls.at(-1).onRunCreated, 'function', `${name} handed the runner onRunCreated`);
    }
    await later(350);
});

test('without respond the answer is the finished run and its steps, as before', async () => {
    behaviour = 'fast';
    for (const [name, handler, params] of ROUTES) {
        const res = await handler(req(params, {}), makeRes());
        assert.strictEqual(res.statusCode, 200, `${name}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.run.status, 'success', name);
        assert.ok(Array.isArray(res.body.steps), name);
    }
});

test('past the response cap the answer is 202 with the run id, never a bare 202', async () => {
    behaviour = 'slow';
    process.env.AUTOMATION_RUN_RESPONSE_CAP_MS = '20';
    try {
        for (const [name, handler, params] of ROUTES) {
            const res = await handler(req(params, {}), makeRes());
            assert.strictEqual(res.statusCode, 202, `${name}: ${JSON.stringify(res.body)}`);
            assert.ok(res.body.runId, `${name}: a 202 always names the run`);
        }
    } finally {
        delete process.env.AUTOMATION_RUN_RESPONSE_CAP_MS;
    }
    await later(350);
});

test('a runner that ends without a run and never named one is an error, not "still running"', async () => {
    behaviour = 'null';
    for (const [name, handler, params] of ROUTES) {
        const res = await handler(req(params, {}), makeRes());
        assert.strictEqual(res.statusCode, 500, `${name}: ${JSON.stringify(res.body)}`);
        assert.notStrictEqual(res.body?.pending, true, name);
    }
});

test('respond accepts only "created" or "finished"', async () => {
    const [, handler] = ROUTES[0];
    const res = await handler(req({}, { respond: 'later' }), makeRes());
    assert.strictEqual(res.statusCode, 400);
});
