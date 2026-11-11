'use strict';

/**
 * The waiting steps in a run on the server, against the REAL run store on PGlite with the harness
 * of backgroundRun.test.js: a long `wait` puts the run on hold and the wake job continues it, a
 * short one is held in the run; an `await_approval` asks (through a fake request), goes on hold
 * for that approval, shows who decides, and continues with the decision (once, however often it
 * is delivered); a cancelled or refused wait withdraws its request; the wake job asks the
 * approval side first.
 *
 * Run: cd server && node --test appStudio/backgroundRun.waits.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const BG = require('./backgroundRun.mts');
const { runAwaitApproval } = require('./actionExecutor/steps/await_approval.mts');
const { continueWaitingRuns } = require('./approvalWaits.mts');
const { backgroundRunHarness } = require('../testUtils/backgroundRunHarness.testkit');

const { s, store, deps, startAndSettle } = backgroundRunHarness({ before, after, beforeEach });

const HOUR = 3_600_000;
const create = (tableId) => ({ kind: 'create_record', tableId, values: {} });
const ran = () => s.executed.map((e) => e.step.tableId || e.step.kind);
const onServer = (...steps) => ({ kind: 'sequence', runOn: 'server', steps });
const ASK = { kind: 'await_approval', prompt: { kind: 'static', value: 'Order 7?' }, assigneeGroupId: 'grp_fin', timeoutHours: 48, resultVar: 'approval' };

async function settle(jobId) {
    await BG._settled(jobId);
    return store.getRun('app_1', jobId);
}

/** The executor: await_approval through its real executor with a fake request; every other step answers its table. */
function asking(asked = []) {
    const fake = {
        request: async (_app, _model, step, _ctx, opts) => { asked.push({ step, opts }); return { ok: true, result: { approvalId: 'apr_1', status: 'pending', expiresAt: new Date(s.clock + 48 * HOUR).toISOString() } }; },
        getApproval: async (id) => ({ id, assigneeGroupId: 'grp_fin' }),
        groupName: async () => 'Finance',
        userName: async () => null,
        limits: () => s.limits,
    };
    s.execute = async (app, model, step, ctx) => (step.kind === 'await_approval' ? runAwaitApproval(app, model, step, ctx, fake) : { ok: true, result: { done: step.tableId } });
    return asked;
}

const decided = (over = {}) => ({
    id: 'apr_1', source: 'app', stepId: 'await_approval', studioAppId: 'app_1', status: 'approved',
    decisionReason: null, answers: { po: '7' }, decidedBy: 'u2', decidedByName: 'Ann', decidedAt: '2026-11-11T10:00:00.000Z', ...over,
});

test('a long wait puts the run on hold until its time, and the wake job continues it', async () => {
    const row = await startAndSettle(onServer(create('a'), { kind: 'wait', seconds: 7200 }, create('b')));
    assert.equal(row.status, 'paused', row.error);
    assert.deepEqual(ran(), ['a'], 'the wait never reached the executor');
    assert.equal(Date.parse(row.wakeAt), 1_000_000 + 2 * HOUR);
    assert.equal(row.progress.waiting, 'timer');
    s.clock += 2 * HOUR;
    await BG.wakeDueRuns(deps());
    const done = await settle(row.id);
    assert.equal(done.status, 'success', done.error);
    assert.deepEqual(ran(), ['a', 'b']);
});

test('a short wait is held in the run; a wait until a moment that passed does not wait', async () => {
    let row = await startAndSettle(onServer({ kind: 'wait', seconds: 5 }, create('b')));
    assert.equal(row.status, 'success', row.error);
    assert.equal(s.sleeps.reduce((a, b) => a + b, 0), 5000);
    s.sleeps = [];
    row = await startAndSettle(onServer({ kind: 'wait', until: { kind: 'formula', expr: 'vars.at' } }, create('c')), { scope: { vars: { at: '1970-01-01T00:00:01Z' } } });
    assert.equal(row.status, 'success', row.error);
    assert.deepEqual(s.sleeps, []);
    row = await startAndSettle(onServer({ kind: 'wait', until: { kind: 'formula', expr: 'vars.at' } }), { scope: { vars: { at: new Date(1_000_000 + HOUR).toISOString() } } });
    assert.equal(row.status, 'paused');
    assert.equal(Date.parse(row.wakeAt), 1_000_000 + HOUR);
    row = await startAndSettle(onServer({ kind: 'wait', until: { kind: 'formula', expr: 'vars.at' } }), { scope: { vars: { at: 'next tuesday' } } });
    assert.equal(row.errorCode, 'wait_until_invalid');
});

test('await_approval asks once, waits for that approval, shows who decides and goes on with the decision', async () => {
    const asked = asking();
    const row = await startAndSettle(onServer(create('a'), ASK, create('b')));
    assert.equal(row.status, 'paused', row.error);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].opts.stepId, 'await_approval');
    assert.equal(asked[0].step.kind, 'request_approval');
    assert.equal(asked[0].step.expiresInHours, 48);
    assert.equal(asked[0].step.resultVar, undefined);
    assert.equal(row.waitKind, 'approval');
    assert.equal(row.waitRef, 'apr_1');
    assert.equal(Date.parse(row.wakeAt), 1_000_000 + 48 * HOUR);
    assert.deepEqual(BG.toJobView(row).progress.waitingFor, { kind: 'group', name: 'Finance' });

    const resumeWaiting = (k, r, p) => BG.resumeWaiting(k, r, p, deps());
    assert.equal(await continueWaitingRuns(decided({ stepId: null }), { resumeWaiting }), 0, 'a plain request_approval continues nothing');
    assert.equal(await continueWaitingRuns(decided({ status: 'pending' }), { resumeWaiting }), 0);
    assert.equal(await continueWaitingRuns(decided(), { resumeWaiting }), 1);
    assert.equal(await continueWaitingRuns(decided({ status: 'rejected' }), { resumeWaiting }), 0, 'a second delivery finds nothing waiting');
    const done = await settle(row.id);
    assert.equal(done.status, 'success', done.error);
    assert.deepEqual(ran(), ['a', 'await_approval', 'b']);
    assert.deepEqual(done.vars.approval, { decision: 'approved', reason: null, answers: { po: '7' }, decidedBy: 'u2', decidedByName: 'Ann', decidedAt: '2026-11-11T10:00:00.000Z', approvalId: 'apr_1' });
});

test('a cancelled or refused wait withdraws its request; the wake job asks the approval side first', async () => {
    asking();
    const released = [];
    const settled = [];
    const waits = {
        release: async (...a) => { released.push(a); return true; },
        settle: async (row) => { settled.push(row.id); return true; },
    };
    const row = await startAndSettle(onServer(ASK, create('b')), {}, deps({ waits }));
    assert.equal(row.status, 'paused');
    await BG.wakeDueRuns(deps({ waits }));
    assert.deepEqual(settled, [row.id], 'a due approval wait is settled by the approval side, not by the timer');
    assert.equal((await store.getRun('app_1', row.id)).status, 'paused');
    assert.equal(await BG.cancelBackgroundRun('app_1', row.id, deps({ waits })), 'cancelled');
    assert.deepEqual(released, [['app_1', 'approval', 'apr_1', 'The run that asked was cancelled.']]);

    s.limits.pausedPerApp = 1;
    await startAndSettle(onServer(ASK), {}, deps({ waits }));
    const refused = await startAndSettle(onServer(ASK), {}, deps({ waits }));
    assert.equal(refused.errorCode, 'pause_limit');
    assert.equal(released.length, 2);
    assert.equal(released[1][3], 'The run that asked could not wait for the decision.');
});
