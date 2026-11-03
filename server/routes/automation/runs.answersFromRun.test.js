'use strict';

/**
 * POST /:id/dry-run, the two new requests (D1, pauses F12):
 *
 *   pauses: 'real'      the web builder's Dry run: executeAutomation gets
 *                       pausesRequested and origin 'builder'; without it the
 *                       run synthesises its pauses, as mobile and the API expect
 *   answersFromRunId    "restart with my answers": the form answers and the
 *                       approval decisions of that earlier run become the dry
 *                       run's harness (typed answers only, no file, no decider);
 *                       a run of another automation is 404, a run that used its
 *                       starter's own connections 409
 *
 * and the 200 reply's run.warnings names what the run did without a person.
 *
 * Route handlers invoked directly; functions swapped on the module objects
 * (testUtils/swaps.js), no module mocking. Synthetic data only.
 * Run: node --test routes/automation/runs.answersFromRun.test.js
 */
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');
const automationStore = require('../../stores/automationStore');
const runner = require('../../core/automationRunner');

const DEF = {
    trigger: { id: 'trg', kind: 'form', form: { title: 'Order', fields: [{ name: 'email', type: 'email', label: 'E-mail' }, { name: 'doc', type: 'file', label: 'Doc' }] } },
    steps: [
        { id: 'ap', type: 'approval', title: 'Sign-off', prompt: 'OK?', approval: { fields: [{ name: 'budget', label: 'Budget', type: 'number' }] } },
        { id: 'fp', type: 'form_page', mode: 'input', title: 'Delivery', form: { title: 'Delivery', fields: [{ name: 'street', type: 'text', label: 'Street' }] } },
    ],
    edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'fp' }],
};
const AUTOMATION = { id: 'a1', userId: 'user1', definition: DEF, liveVersion: 1 };

const SOURCE_RUNS = {
    'src-1': { id: 'src-1', automationId: 'a1', version: 1, userId: 'user1', status: 'error', rootRunId: 'src-1', parentRunId: null,
        triggerPayload: { email: 'person@example.test', doc: { kind: 'form_upload', fileId: 'f-secret' } } },
    'src-2': { id: 'src-2', automationId: 'a1', version: 1, userId: 'user1', status: 'error', rootRunId: 'src-1', parentRunId: 'src-1' },
    'other-auto': { id: 'other-auto', automationId: 'a2', version: 1, userId: 'user1', status: 'success', rootRunId: 'other-auto' },
    'caller-run': { id: 'caller-run', automationId: 'a1', version: 1, userId: 'user1', status: 'success', rootRunId: 'caller-run', connectionsMode: 'caller', startedByUserId: 'user1' },
};
const SOURCE_STEPS = [
    { runId: 'src-1', stepId: 'ap', parentStepId: null, status: 'awaiting_approval', output: { prompt: 'OK?' } },
    { runId: 'src-2', stepId: 'ap', parentStepId: null, status: 'success',
        output: { approved: true, by: 'person-7', reason: 'fine', decidedAt: '2026-11-01T09:00:00.000Z', answers: { budget: 900 }, votes: [] } },
    { runId: 'src-2', stepId: 'fp', parentStepId: null, status: 'success', output: { street: 'Main Street 1' } },
];

let calls = [];
let replySteps = [];
const { swap, restore } = makeSwaps();
before(() => {
    swap(automationStore, 'getAutomation', async (id) => (id === 'a1' ? { ...AUTOMATION } : null));
    swap(automationStore, 'getRun', async (id) => (SOURCE_RUNS[id] ? { ...SOURCE_RUNS[id] } : null));
    swap(automationStore, 'getRunsInChain', async (id) => (id === 'src-1' || id === 'src-2' ? [SOURCE_RUNS['src-1'], SOURCE_RUNS['src-2']] : [SOURCE_RUNS[id]]));
    swap(automationStore, 'getRunStepsForChain', async () => SOURCE_STEPS);
    swap(automationStore, 'getVersionDefinition', async () => DEF);
    swap(automationStore, 'getRunSteps', async () => replySteps);
    swap(runner, 'executeAutomation', async (_a, opts) => {
        calls.push(opts);
        opts.onRunCreated?.({ id: 'dry-1' });
        return { id: 'dry-1', status: 'success', mode: 'dry_run', triggerPayload: opts.triggerPayload };
    });
});
beforeEach(() => { calls = []; replySteps = []; });

const { runRoute, makeRes } = require('../../testUtils/routeHandlers');
const dryRun = runRoute(require('./runs'), 'post', '/:id/dry-run');
after(() => { restore(); setImmediate(() => process.exit(process.exitCode || 0)); });

const req = (body) => ({ params: { id: 'a1' }, query: {}, session: { user: { id: 'user1' } }, body });

test("pauses 'real' asks the runner to pause for real, as the builder", async () => {
    const res = await dryRun(req({ pauses: 'real', triggerPayload: { email: 'x@example.test' } }), makeRes());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(calls[0].mode, 'dry_run');
    assert.strictEqual(calls[0].pausesRequested, true);
    assert.strictEqual(calls[0].origin, 'builder');
    assert.strictEqual(calls[0].harness, undefined);
});

test('without the flag the run synthesises, and the reply warns per simulated step', async () => {
    replySteps = [
        { stepId: 'ap', status: 'success', output: { approved: true, answers: {}, _dryRun: true, _dryRunSynthesised: true, _dryRunFallback: 'auto_approved' } },
        { stepId: 'fp', status: 'success', output: { street: '', _dryRun: true, _dryRunSynthesised: true, _dryRunFallback: 'form_blank' } },
    ];
    const res = await dryRun(req({}), makeRes());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls[0].pausesRequested, false);
    assert.strictEqual(calls[0].origin, undefined);
    const text = res.body.run.warnings.join('\n');
    assert.match(text, /The form trigger had no answers/);
    assert.match(text, /Approval "Sign-off" was auto-approved \(simulated\)/);
    assert.match(text, /Form page "Delivery" was answered with blanks \(simulated\)/);
});

test('answersFromRunId: the earlier journey answers become the harness, typed answers only', async () => {
    const res = await dryRun(req({ answersFromRunId: 'src-2', pauses: 'real' }), makeRes());
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const opts = calls[0];
    assert.deepStrictEqual(opts.triggerPayload, { email: 'person@example.test' }, 'the typed trigger answers, not the upload');
    assert.deepStrictEqual(opts.harness, {
        source: { kind: 'run', id: 'src-1' },
        formAnswers: { pages: { fp: { street: 'Main Street 1' } } },
        approvals: { ap: { decision: 'approve', answers: { budget: 900 } } },
        aiAnswers: 'live',
    });
    const json = JSON.stringify(opts.harness);
    for (const v of ['person-7', 'fine', 'f-secret']) assert.ok(!json.includes(v), `kept ${v}`);
    assert.deepStrictEqual(res.body.run.warnings, [], 'the trigger had answers, nothing was simulated');
});

test('a triggerPayload in the request wins over the replayed one', async () => {
    await dryRun(req({ answersFromRunId: 'src-1', triggerPayload: { email: 'new@example.test' } }), makeRes());
    assert.deepStrictEqual(calls[0].triggerPayload, { email: 'new@example.test' });
    assert.ok(calls[0].harness, 'the page and approval answers are still played');
});

test('a run of another automation is not found; a caller-connections run is refused', async () => {
    const other = await dryRun(req({ answersFromRunId: 'other-auto' }), makeRes());
    assert.strictEqual(other.statusCode, 404);
    const caller = await dryRun(req({ answersFromRunId: 'caller-run' }), makeRes());
    assert.strictEqual(caller.statusCode, 409);
    assert.strictEqual(caller.body.code, 'caller_run_not_capturable');
    const missing = await dryRun(req({ answersFromRunId: 'nope' }), makeRes());
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(calls.length, 0, 'no run started');
});

test('the body stays strict: an unknown pauses value or a stray key is a 400', async () => {
    for (const body of [{ pauses: 'synthesise' }, { pauses: true }, { answersFromRunId: '' }, { test: true }]) {
        const res = await dryRun(req(body), makeRes());
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    }
    assert.strictEqual(calls.length, 0);
});
