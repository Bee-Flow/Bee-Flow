'use strict';

/**
 * The builder's form overlay beyond a form page (GET/POST /runs/:runId/form):
 *   - a journey waiting on an APPROVAL shows it: the approval row's snapshot
 *     (prompt, details, fields), whether the caller may decide, who it waits on;
 *   - a finished journey shows the closing page it ended on;
 *   - answering is refused for a journey a real visitor is in (409 public_journey);
 *   - an answer with respond "created" is 202 { runId } at once, the answered
 *     leg is closed when the child exists, and the stream hears it
 *     (studio-and-forms F12, run-watch F10).
 *
 * Run: node --test routes/automation/webhooksAndRunOps.runFormApproval.test.js
 */
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');
const automationStore = require('../../stores/automationStore');
const userStore = require('../../stores/userStore');
const runner = require('../../core/automationRunner');

const PAGE = { title: 'Page two', fields: [{ name: 'address', type: 'text', label: 'Address', required: true }] };
const SNAPSHOT_FIELDS = [{ name: 'po', type: 'text', label: 'PO number (as asked)', required: true }];
let RUNS = {};
let STEPS = {};
let APPROVAL = null;
let SESSIONS = [];
let WORKING = { id: 'a1', userId: 'user1', definition: { steps: [{ id: 'ap_1', type: 'approval', approval: { fields: [{ name: 'po', label: 'CHANGED IN THE BUILDER' }] } }] } };
const calls = { updateRun: [], resume: [] };
const later = (ms) => new Promise((r) => setTimeout(r, ms));

function reset() {
    RUNS = {
        r1: { id: 'r1', userId: 'user1', automationId: 'a1', status: 'awaiting_form', awaitingStepId: 'fp_2', rootRunId: 'r1', mode: 'live', isTest: true },
    };
    STEPS = { r1: [{ stepId: 'fp_2', status: 'awaiting_form', output: { form: PAGE } }] };
    APPROVAL = null;
    SESSIONS = [];
    WORKING = { ...WORKING, version: undefined };
    calls.updateRun.length = 0;
    calls.resume.length = 0;
}

// No module mocking: functions are swapped ON the module objects for the
// duration of the file and put back after (runs.runsTab.test.js does the same).
const { swap, restore } = makeSwaps();
before(() => {
    swap(automationStore, 'getRun', async (id) => (RUNS[id] ? { ...RUNS[id] } : null));
    swap(automationStore, 'getAutomation', async () => ({ ...WORKING }));
    swap(automationStore, 'getRunSteps', async (id) => (STEPS[id] || []).map((s) => ({ ...s })));
    swap(automationStore, 'getLatestRunInChain', async (id) => (RUNS[id] ? { ...RUNS[id] } : null));
    swap(automationStore, 'getPendingApprovalIdsForRuns', async () => new Map());
    swap(automationStore, 'getApprovalForRunStep', async (runId, stepId) => (APPROVAL && APPROVAL.runId === runId && APPROVAL.stepId === stepId ? { ...APPROVAL } : null));
    swap(automationStore, 'getFormSessionsForJourney', async () => SESSIONS);
    swap(automationStore, 'updateRun', async (id, updates) => { calls.updateRun.push({ id, updates }); if (RUNS[id]) Object.assign(RUNS[id], updates); return true; });
    swap(userStore, 'getUser', async (id) => ({ id, organizationId: 'org1', groups: '["g-finance"]', orgRole: 'member' }));
    swap(runner, 'resumeFromStep', async (runId, stepId, opts) => {
        calls.resume.push({ runId, stepId, opts });
        RUNS.r2 = { id: 'r2', userId: 'user1', automationId: 'a1', status: 'running', rootRunId: 'r1', mode: 'live' };
        await opts.onRunCreated?.({ id: 'r2' });
        await later(200);
        return { id: 'r2', status: 'success' };
    });
});

const { runRoute, makeRes } = require('../../testUtils/routeHandlers');
const router = require('./webhooksAndRunOps');
const { onAny } = require('../../core/runEventBus');
after(() => { restore(); setImmediate(() => process.exit(process.exitCode || 0)); });

const getForm = runRoute(router, 'get', '/runs/:runId/form');
const postForm = runRoute(router, 'post', '/runs/:runId/form');
const getRun = runRoute(router, 'get', '/runs/:id');
const req = (params, body = {}, userId = 'user1') => ({ params, body, query: {}, session: { user: { id: userId } } });

function waitOnApproval(extra = {}) {
    Object.assign(RUNS.r1, { status: 'awaiting_approval', awaitingStepId: 'ap_1' });
    APPROVAL = {
        id: 'apr_1', runId: 'r1', stepId: 'ap_1', ownerId: 'user1', status: 'pending', organizationId: 'org1',
        prompt: 'Approve the order?', detailsMd: '**Total** 120', fields: SNAPSHOT_FIELDS, ...extra,
    };
}

test('a journey waiting on an approval shows it from the row snapshot, decidable by its owner', async () => {
    reset();
    waitOnApproval();
    const res = await getForm(req({ runId: 'r1' }), makeRes());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.waiting, false);
    const p = res.body.pendingApproval;
    assert.strictEqual(p.approvalId, 'apr_1');
    assert.strictEqual(p.prompt, 'Approve the order?');
    assert.strictEqual(p.detailsMd, '**Total** 120');
    // The approver decides on what was ASKED, never on today's working copy.
    assert.deepStrictEqual(p.fields, SNAPSHOT_FIELDS);
    assert.strictEqual(p.canDecide, true);
    assert.deepStrictEqual(p.waitingOn, { stageName: null, seatCount: 1 });
    assert.strictEqual(p.isTest, true);
});

test('a staged approval names its current stage; a seat the caller does not hold cannot decide', async () => {
    reset();
    waitOnApproval({
        stages: [
            { key: 's1', name: 'Finance', approvers: [{ userId: 'fin1' }, { groupId: 'g-other' }], rule: 'any' },
            { key: 's2', name: 'Board', approvers: [{ userId: 'b1' }], rule: 'any' },
        ],
        stage: 's1',
    });
    const res = await getForm(req({ runId: 'r1' }), makeRes());
    assert.deepStrictEqual(res.body.pendingApproval.waitingOn, { stageName: 'Finance', seatCount: 2 });
    assert.strictEqual(res.body.pendingApproval.canDecide, false);
});

test('a finished journey shows the closing page it ended on', async () => {
    reset();
    Object.assign(RUNS.r1, { status: 'success', awaitingStepId: null });
    STEPS.r1 = [{ stepId: 'end', status: 'success', output: { mode: 'ending', form: { title: 'Thanks!', description: 'All done.' } } }];
    const res = await getForm(req({ runId: 'r1' }), makeRes());
    assert.deepStrictEqual(res.body.ending, { title: 'Thanks!', description: 'All done.' });
    assert.strictEqual(res.body.pendingApproval, undefined);
});

test('GET /runs/:id carries the profile, versionBehind for a test run, and canDecide/waitingOn while waiting', async () => {
    reset();
    waitOnApproval();
    RUNS.r1.version = 3;
    WORKING = { ...WORKING, version: 5 };
    {
        const res = await getRun(req({ id: 'r1' }), makeRes());
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        const run = res.body.run;
        assert.deepStrictEqual(run.profile, { kind: 'test', effects: 'real', pauses: 'real', approverSeat: { kind: 'configured' }, stopAfterStepId: null });
        assert.strictEqual(run.versionBehind, true);
        assert.strictEqual(run.approvalId, 'apr_1');
        assert.strictEqual(run.canDecide, true);
        assert.deepStrictEqual(run.waitingOn, { stageName: null, seatCount: 1 });
    }
});

test('GET /runs/:id reads a stored run profile when the row has one; a production run is never "behind"', async () => {
    reset();
    Object.assign(RUNS.r1, { status: 'success', awaitingStepId: null, isTest: false, version: 1,
        runProfile: { v: 1, kind: 'production', effects: 'real', pauses: 'real', approverSeat: { kind: 'configured' }, stopAfterStepId: null } });
    const res = await getRun(req({ id: 'r1' }), makeRes());
    assert.strictEqual(res.body.run.profile.kind, 'production');
    assert.strictEqual(res.body.run.versionBehind, undefined);
    assert.strictEqual(res.body.run.canDecide, undefined);
});

test('answering a page of a journey a real visitor is in is refused; a test link\'s is not', async () => {
    reset();
    SESSIONS = [{ id: 's1', isTest: false }];
    const res = await postForm(req({ runId: 'r1' }, { stepId: 'fp_2', values: { address: 'x' } }), makeRes());
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'public_journey');
    assert.strictEqual(calls.resume.length, 0);

    reset();
    SESSIONS = [{ id: 's2', isTest: true }];
    const ok = await postForm(req({ runId: 'r1' }, { stepId: 'fp_2', values: { address: 'x' } }), makeRes());
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    await later(10);
});

test('respond "created": 202 with the child id at once; the answered leg closes and the stream hears it', async () => {
    reset();
    const events = [];
    const off = onAny((e) => events.push(e));
    const started = Date.now();
    const res = await postForm(req({ runId: 'r1' }, { stepId: 'fp_2', values: { address: 'Dorpsstraat 1' }, respond: 'created' }), makeRes());
    off();
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    assert.strictEqual(res.body.runId, 'r2');
    assert.ok(Date.now() - started < 150, 'did not wait for the continuation');
    const closed = calls.updateRun.find((u) => u.id === 'r1');
    assert.ok(closed, 'the answered leg was closed');
    assert.strictEqual(closed.updates.status, 'success');
    assert.match(closed.updates.summary, /r2/);
    const finished = events.find((e) => e.type === 'run.finished' && e.runId === 'r1');
    assert.ok(finished, 'run.finished for the answered leg');
    assert.strictEqual(finished.rootRunId, 'r1');
    assert.strictEqual(finished.continuedBy, 'r2');
    await later(250);
    assert.strictEqual(calls.updateRun.filter((u) => u.id === 'r1').length, 1, 'closed once, not again when the child ended');
});
