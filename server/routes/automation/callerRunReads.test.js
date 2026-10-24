// @typecheck
'use strict';

/**
 * Who may read the DATA of a run that used its starter's own connections
 * (runs.connections_mode = 'caller'): the starter, nobody else. The owner and
 * other sharers keep status, step names, step statuses and timing.
 *
 * Route handlers invoked directly (same Module-mock technique as
 * webhooksAndRunOps.runApprove.test.js).
 *
 * Run: node --test routes/automation/callerRunReads.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { serverStubber } = require('../../testUtils/stubServer');

const mock = serverStubber();

const OWNER = 'u-owner';
const STARTER = 'u-starter';
const VIEWER = 'u-viewer';

const RUN = {
    id: 'run1', userId: OWNER, automationId: 'a1', version: 1, status: 'success', mode: 'live',
    startedByUserId: STARTER, connectionsMode: 'caller', triggerKind: 'manual',
    triggerPayload: { subject: 'zebra payroll' }, summary: 'Sent the zebra report', error: null, errorClass: null,
    outcome: { code: 'success', params: { file: 'zebra.pdf' }, text: 'Sent zebra.pdf' }, startedAt: '2026-10-16T10:00:00.000Z',
};
const ORDINARY = { ...RUN, id: 'run2', connectionsMode: null };
const RUNNING = { ...RUN, id: 'run3', status: 'running', startedByUserId: STARTER };
const FORM_WAIT = { ...RUN, id: 'run4', status: 'awaiting_form', awaitingStepId: 'page' };
// A journey whose first leg ran as an ordinary run and whose second leg (started by STARTER) is caller mode.
const LEG1 = { ...ORDINARY, id: 'leg1', userId: OWNER };
const LEG2 = { ...RUN, id: 'leg2', rootRunId: 'leg1' };
const STEPS = [{
    runId: 'run1', stepId: 's1', parentStepId: null, stepType: 'integration_action', attempts: 1, status: 'success',
    startedAt: 't0', finishedAt: 't1', input: { q: 'zebra' }, output: { subject: 'zebra payroll' }, error: null, errorClass: null,
    errorInfo: { technical: 'zebra' }, bindingWarnings: null, toolsWithheld: null, piiSummary: null, identityUserId: STARTER, branchIndex: null,
}];
const calls = { executes: [], fullOutput: 0 };

mock('stores/automationStore', {
    getRun: async (id) => ({ run1: { ...RUN }, run2: { ...ORDINARY }, run3: { ...RUNNING }, run4: { ...FORM_WAIT }, leg1: { ...LEG1 } }[id] || null),
    getRunsInChain: async (id) => (id === 'leg1' ? [{ ...LEG1 }, { ...LEG2 }] : [{ ...RUN }]),
    getAutomation: async () => ({ id: 'a1', userId: OWNER, definition: {}, organizationId: 'org1' }),
    getLatestRunInChain: async () => null,
    getRunStepsForChain: async (id) => (id === 'leg1'
        ? [{ ...STEPS[0], runId: 'leg1', stepId: 'a' }, { ...STEPS[0], runId: 'leg2', stepId: 'b' }]
        : STEPS.map(s => ({ ...s }))),
    getRunSteps: async () => STEPS.map(s => ({ ...s })),
    getVersionDefinition: async () => ({ steps: [] }),
    getRunFullOutput: async () => { calls.fullOutput += 1; return { secret: 'zebra' }; },
    listSharesForAutomation: async () => [{ principalType: 'user', principalId: STARTER, role: 'run' }, { principalType: 'user', principalId: VIEWER, role: 'view' }],
    getPendingApprovalIdsForRuns: async () => new Map(),
});
mock('stores/userStore', {
    getUser: async (id) => ({ id, organizationId: 'org1', groups: [] }),
});
mock('auth/permissions', { hasPermission: async () => false });
mock('core/automationRunner', {
    executeAutomation: async (a, opts) => { calls.executes.push(opts); return { id: 'run3', status: 'success' }; },
    requestCancel: async (id) => ({ ...RUNNING, id, status: 'cancelled', summary: 'private summary', error: 'private error' }),
});
mock('utils/perUserRateLimit', { perUserRateLimit: () => (req, res, next) => next() });

const { runRoute: runRouteOf, makeRes } = require('../../testUtils/routeHandlers');
const router = require('./webhooksAndRunOps');
const runRoute = (method, routePath) => runRouteOf(router, method, routePath);
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const asUser = (userId, params, extra = {}) => ({ params, query: {}, body: {}, session: { user: { id: userId } }, ...extra });

const detail = runRoute('get', '/runs/:id');
const stepsRoute = runRoute('get', '/runs/:id/steps');
const fullOutput = runRoute('get', '/runs/:id/steps/:stepId/full-output');
const cancel = runRoute('post', '/runs/:runId/cancel');
const formGet = runRoute('get', '/runs/:runId/form');
const formPost = runRoute('post', '/runs/:runId/form');
const retry = runRoute('post', '/:id/runs/:runId/retry');

test('run detail: the starter sees everything, the owner and a viewer see status and timing only', async () => {
    const mine = await detail(asUser(STARTER, { id: 'run1' }), makeRes());
    assert.deepStrictEqual(mine.body.run.triggerPayload, { subject: 'zebra payroll' });
    assert.strictEqual(mine.body.run.summary, 'Sent the zebra report');
    for (const who of [OWNER, VIEWER]) {
        const res = await detail(asUser(who, { id: 'run1' }), makeRes());
        assert.strictEqual(res.statusCode, 200, who);
        const run = res.body.run;
        assert.strictEqual(run.status, 'success');
        assert.strictEqual(run.startedAt, '2026-10-16T10:00:00.000Z');
        assert.ok(!('triggerPayload' in run) && !('summary' in run) && !('error' in run));
        assert.deepStrictEqual(run.outcome, { code: 'success', params: {}, text: null });
        assert.ok(!JSON.stringify(run).includes('zebra'), `nothing of the run's data reaches ${who}`);
    }
});

test('run detail: an ordinary run is unchanged for the owner', async () => {
    const res = await detail(asUser(OWNER, { id: 'run2' }), makeRes());
    assert.deepStrictEqual(res.body.run.triggerPayload, { subject: 'zebra payroll' });
});

test('step rows: payloads for the starter; names, statuses and timing for the owner', async () => {
    const mine = await stepsRoute(asUser(STARTER, { id: 'run1' }), makeRes());
    assert.deepStrictEqual(mine.body.steps[0].output, { subject: 'zebra payroll' });
    assert.strictEqual(mine.body.steps[0].identityUserId, STARTER);
    for (const who of [OWNER, VIEWER]) {
        const res = await stepsRoute(asUser(who, { id: 'run1' }), makeRes());
        const s = res.body.steps[0];
        assert.deepStrictEqual([s.stepId, s.stepType, s.status, s.startedAt, s.finishedAt], ['s1', 'integration_action', 'success', 't0', 't1']);
        assert.ok(!('input' in s) && !('output' in s) && !('error' in s) && !('errorInfo' in s));
        assert.ok(!JSON.stringify(res.body.steps).includes('zebra'));
    }
});

test('full output: only the starter may fetch it', async () => {
    calls.fullOutput = 0;
    const owner = await fullOutput(asUser(OWNER, { id: 'run1', stepId: 's1' }, { query: { attempts: 1 } }), makeRes());
    assert.strictEqual(owner.statusCode, 403);
    assert.strictEqual(owner.body.code, 'caller_run_private');
    assert.strictEqual(calls.fullOutput, 0, 'the copy is not even read');
    const starter = await fullOutput(asUser(STARTER, { id: 'run1', stepId: 's1' }, { query: { attempts: 1 } }), makeRes());
    assert.deepStrictEqual(starter.body.output, { secret: 'zebra' });
});

test('retry replays the starter\'s payload, so only the starter may run it again', async () => {
    calls.executes.length = 0;
    const owner = await retry(asUser(OWNER, { id: 'a1', runId: 'run1' }), makeRes());
    assert.strictEqual(owner.statusCode, 403);
    assert.strictEqual(owner.body.code, 'caller_run_private');
    assert.strictEqual(calls.executes.length, 0);
});

test('cancel answers the owner with the run\'s state, not its values; the starter keeps them', async () => {
    const owner = await cancel(asUser(OWNER, { runId: 'run3' }), makeRes());
    assert.strictEqual(owner.statusCode, 202);
    assert.strictEqual(owner.body.run.status, 'cancelled');
    assert.ok(!JSON.stringify(owner.body.run).includes('private'));
    const starter = await cancel(asUser(STARTER, { runId: 'run3' }), makeRes());
    assert.strictEqual(starter.body.run.summary, 'private summary');
});

test('a form page of a caller-mode run is read and answered by the starter only', async () => {
    for (const who of [OWNER, VIEWER]) {
        const read = await formGet(asUser(who, { runId: 'run4' }), makeRes());
        assert.strictEqual(read.statusCode, 403, who);
        assert.strictEqual(read.body.code, 'caller_run_private');
    }
    const answered = await formPost(asUser(OWNER, { runId: 'run4' }, { body: { values: { a: 1 } } }), makeRes());
    assert.strictEqual(answered.statusCode, 403);
    assert.strictEqual(answered.body.code, 'caller_run_private');
    assert.strictEqual(calls.executes.length, 0, 'nothing was continued');
    const starter = await formGet(asUser(STARTER, { runId: 'run4' }), makeRes());
    assert.notStrictEqual(starter.statusCode, 403);
});

test('a journey is redacted leg by leg: an ordinary first leg stays readable, the caller-mode leg does not', async () => {
    const res = await stepsRoute(asUser(OWNER, { id: 'leg1' }), makeRes());
    const [first, second] = res.body.steps;
    assert.deepStrictEqual(first.output, { subject: 'zebra payroll' });
    assert.ok(!('output' in second) && !('input' in second));
    assert.strictEqual(second.status, 'success');
});
