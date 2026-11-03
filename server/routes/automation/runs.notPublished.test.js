'use strict';

/**
 * RM-11: a colleague with run access must not run the author's working copy as
 * a production run. POST /:id/run without `test` on an automation that has no
 * live copy (never published) is refused with 409 not_published for a caller
 * who may not edit it; an editor's test run, an owner's run and a run of a
 * published automation are unchanged.
 *
 * Route handlers invoked directly (same technique as runs.callerConnections.test.js).
 * Run: node --test routes/automation/runs.notPublished.test.js
 */
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');
const automationStore = require('../../stores/automationStore');
const userStore = require('../../stores/userStore');
const permissions = require('../../auth/permissions');
const runner = require('../../core/automationRunner');

const DEF = { trigger: { id: 'trg', kind: 'manual' }, steps: [{ id: 's1', type: 'set', fields: {} }], edges: [{ from: 'trg', to: 's1' }] };
let AUTOMATION = {};
const calls = [];

// No module mocking: functions are swapped ON the module objects for the
// duration of the file and put back after (runs.runsTab.test.js does the same).
const { swap, restore } = makeSwaps();
before(() => {
    swap(automationStore, 'getAutomation', async (id) => (id === 'a1' ? { ...AUTOMATION } : null));
    swap(automationStore, 'getRunSteps', async () => []);
    swap(automationStore, 'listSharesForAutomation', async () => [
        { principalType: 'user', principalId: 'runner2', role: 'run' },
        { principalType: 'user', principalId: 'editor3', role: 'edit' },
    ]);
    swap(automationStore, 'getCallerNoticeAck', async () => null);
    swap(userStore, 'getUser', async (id) => ({ id, organizationId: 'org1', groups: [] }));
    swap(permissions, 'hasPermission', async () => false);
    swap(runner, 'executeAutomation', async (a, opts) => { calls.push(opts); return { id: `run-${calls.length}`, status: 'success' }; });
});

const { runRoute, makeRes } = require('../../testUtils/routeHandlers');
const router = require('./runs');
after(() => { restore(); setImmediate(() => process.exit(process.exitCode || 0)); });

const run = runRoute(router, 'post', '/:id/run');
const req = (userId, body = {}) => ({ params: { id: 'a1' }, query: {}, session: { user: { id: userId } }, body });
const draft = () => { AUTOMATION = { id: 'a1', userId: 'owner1', organizationId: 'org1', definition: DEF, liveVersion: null }; };

test('a run-only colleague cannot start a never-published automation: 409 not_published, nothing runs', async () => {
    draft();
    calls.length = 0;
    const res = await run(req('runner2'), makeRes());
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'not_published');
    assert.match(res.body.error, /not been published yet/);
    assert.strictEqual(calls.length, 0);
});

test('the owner and an editor still run it; an editor\'s test run is unchanged', async () => {
    draft();
    calls.length = 0;
    assert.strictEqual((await run(req('owner1'), makeRes())).statusCode, 200);
    assert.strictEqual((await run(req('editor3'), makeRes())).statusCode, 200);
    const test = await run(req('editor3', { test: true }), makeRes());
    assert.strictEqual(test.statusCode, 200);
    assert.strictEqual(calls.at(-1).isTest, true);
    assert.strictEqual(calls.length, 3);
});

test('once published, the run-only colleague starts it', async () => {
    draft();
    AUTOMATION.liveVersion = 2;
    AUTOMATION.liveDefinition = DEF;
    calls.length = 0;
    const res = await run(req('runner2'), makeRes());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].startedByUserId, 'runner2');
});
