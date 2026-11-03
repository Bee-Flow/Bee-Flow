'use strict';

/**
 * POST /runs/:runId/cancel on a run waiting on a form page (pauses F6,
 * run-watch F9, tests-and-docs F2). Before, it answered 409 "cannot be
 * cancelled" and the run sat there until the reaper failed it as FormExpired.
 * Now the waiting leg closes as cancelled ("Closed without an answer"), its
 * paused step row says cancelled, the journey's visitor session ends, and the
 * run stream hears it with the journey's rootRunId.
 *
 * Run: node --test routes/automation/webhooksAndRunOps.cancelForm.test.js
 */
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');
const automationStore = require('../../stores/automationStore');
const userStore = require('../../stores/userStore');
const permissions = require('../../auth/permissions');
const runner = require('../../core/automationRunner');

let RUNS = {};
const calls = { updateRun: [], closeStep: [], endSession: [], cancel: [] };
function reset() {
    RUNS = {
        head: { id: 'head', userId: 'user1', automationId: 'a1', status: 'success', rootRunId: 'head', mode: 'live' },
        leg2: { id: 'leg2', userId: 'user1', automationId: 'a1', status: 'awaiting_form', awaitingStepId: 'fp_2', rootRunId: 'head', parentRunId: 'head', mode: 'live', startedByUserId: 'user1' },
    };
    for (const k of Object.keys(calls)) calls[k].length = 0;
}

// No module mocking: functions are swapped ON the module objects for the
// duration of the file and put back after (runs.runsTab.test.js does the same).
const { swap, restore } = makeSwaps();
before(() => {
    swap(automationStore, 'getRun', async (id) => (RUNS[id] ? { ...RUNS[id] } : null));
    swap(automationStore, 'getAutomation', async () => ({ id: 'a1', userId: 'user1', organizationId: 'org1', definition: {} }));
    swap(automationStore, 'getLatestRunInChain', async () => ({ ...RUNS.leg2 }));
    swap(automationStore, 'listSharesForAutomation', async () => []);
    swap(automationStore, 'updateRun', async (id, updates) => { calls.updateRun.push({ id, updates }); Object.assign(RUNS[id], updates); return true; });
    swap(automationStore, 'closeAwaitingStepRow', async (...a) => { calls.closeStep.push(a); return 1; });
    swap(automationStore, 'endFormSessionForRun', async (id) => { calls.endSession.push(id); return 1; });
    swap(userStore, 'getUser', async (id) => ({ id, organizationId: 'org2', groups: [] }));
    swap(permissions, 'hasPermission', async () => false);
    swap(runner, 'requestCancel', async (id) => { calls.cancel.push(id); return null; });
});

const { runRoute, makeRes } = require('../../testUtils/routeHandlers');
const router = require('./webhooksAndRunOps');
const { onAny } = require('../../core/runEventBus');
after(() => { restore(); setImmediate(() => process.exit(process.exitCode || 0)); });

const cancel = runRoute(router, 'post', '/runs/:runId/cancel');
const req = (runId, userId = 'user1') => ({ params: { runId }, body: {}, query: {}, session: { user: { id: userId } } });

test('a run waiting on a form page is closed without an answer, addressed by the journey head', async () => {
    reset();
    const events = [];
    const off = onAny((e) => events.push(e));
    const res = await cancel(req('head'), makeRes());
    off();
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    assert.strictEqual(res.body.run.status, 'cancelled');
    assert.strictEqual(res.body.run.summary, 'Closed without an answer');

    const write = calls.updateRun.find((u) => u.id === 'leg2');
    assert.ok(write, 'the waiting leg was closed, not the head');
    assert.strictEqual(write.updates.status, 'cancelled');
    assert.strictEqual(write.updates.awaitingStepId, null);
    assert.ok(write.updates.finishedAt);

    assert.deepStrictEqual(calls.closeStep, [['leg2', 'fp_2', 'awaiting_form', 'cancelled']]);
    assert.deepStrictEqual(calls.endSession, ['leg2']);
    assert.strictEqual(calls.cancel.length, 0, 'no cancel flag for a run with nothing executing');

    const finished = events.filter((e) => e.type === 'run.finished');
    assert.strictEqual(finished.length, 1);
    assert.strictEqual(finished[0].runId, 'leg2');
    assert.strictEqual(finished[0].rootRunId, 'head');
    assert.strictEqual(finished[0].status, 'cancelled');
    assert.strictEqual(finished[0].startedByUserId, 'user1');
});

test('a dry run is closed the same way but streams nothing (dry runs never do)', async () => {
    reset();
    RUNS.leg2.mode = 'dry_run';
    const events = [];
    const off = onAny((e) => events.push(e));
    const res = await cancel(req('leg2'), makeRes());
    off();
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(RUNS.leg2.status, 'cancelled');
    assert.deepStrictEqual(events, []);
});

test('a session that cannot be ended does not keep the run open', async () => {
    reset();
    const undo = swap(automationStore, 'endFormSessionForRun', async () => { throw new Error('db gone'); });
    try {
        const res = await cancel(req('leg2'), makeRes());
        assert.strictEqual(res.statusCode, 202);
        assert.strictEqual(RUNS.leg2.status, 'cancelled');
    } finally { undo(); }
});

test('somebody without act rights on the run is refused, and nothing is closed', async () => {
    reset();
    const res = await cancel(req('leg2', 'stranger'), makeRes());
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(calls.updateRun.length, 0);
});

test('a finished run still cannot be cancelled', async () => {
    reset();
    RUNS.leg2.status = 'success';
    const res = await cancel(req('leg2'), makeRes());
    assert.strictEqual(res.statusCode, 409);
});
