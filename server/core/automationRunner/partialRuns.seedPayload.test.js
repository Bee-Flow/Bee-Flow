/**
 * RM-8: ▶ Execute on a root step without a chosen run replays the upstream
 * outputs of recent live runs, and now enters with the TRIGGER PAYLOAD of the
 * same window (the newest run that has one), as the loop-body path already did.
 * Before, upstream nodes showed real data while `trigger.output` was {}, so a
 * step mapping `{{trigger.output.email}}` ran with a blank recipient. The run
 * that supplied the payload is reported as `replaySource`.
 *
 * A caller's own payload and a pinned sample on the trigger still win; a chosen
 * run (seedRunId) still gives its own payload.
 *
 * Run: cd server && node --test core/automationRunner/partialRuns.seedPayload.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');
const { installPartialRunHarness } = require('../automationRunner.partial.testkit');

const { runner, runStepsByRun, makeRun, reset } = installPartialRunHarness();
const { configurePartialRuns } = require('./partialRuns');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(() => reset());

/** form trigger → A → B (B maps the submitter's e-mail). */
function automation({ pinnedOutput } = {}) {
    return {
        id: 'auto-1', version: 1, userId: 'user-1', organizationId: null, title: 'Confirm', triggerType: 'form',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'form', ...(pinnedOutput ? { pinnedOutput } : {}) },
            steps: [
                { id: 'A', type: 'set', fields: { ticket: { kind: 'literal', value: 'T-1' } } },
                { id: 'B', type: 'set', fields: { to: { kind: 'ref', path: 'trigger.output.email' }, ticket: { kind: 'ref', path: 'steps.A.output.ticket' } } },
            ],
            edges: [{ from: 'trig', to: 'A' }, { from: 'A', to: 'B' }],
        },
    };
}

/** A recorded live run: its trigger payload and A's output. */
function priorRun(triggerPayload, ticket = 'T-7') {
    const run = makeRun({ automationId: 'auto-1', version: 1, userId: 'user-1', triggerKind: 'form', triggerPayload, mode: 'live' });
    run.status = 'success';
    runStepsByRun.get(run.id).push({ runId: run.id, stepId: 'A', parentStepId: null, stepType: 'set', attempts: 1, status: 'success', output: { ticket } });
    return run;
}

const outputOf = (runId, stepId) => (runStepsByRun.get(runId) || []).find((s) => s.stepId === stepId)?.output;

test('the replayed upstream and trigger.output come from the same recent run', async () => {
    const prior = priorRun({ email: 'ada@example.org' });
    const run = await runner.runPartial(automation(), 'B', { mode: 'only', triggerKind: 'manual_step', startedByUserId: 'user-1' });
    assert.strictEqual(run.status, 'success');
    assert.deepStrictEqual(outputOf(run.id, 'B'), { to: 'ada@example.org', ticket: 'T-7' });
    assert.strictEqual(run.replaySource.runId, prior.id);
    assert.strictEqual(run.replaySource.triggerPayload, true);
    assert.strictEqual(run.triggerPayload.email, 'ada@example.org', 'the run row records what it entered with');
});

test('the newest run WITH a payload supplies it', async () => {
    const older = priorRun({ email: 'old@example.org' });
    priorRun(null, 'T-8');   // newest, but entered with nothing
    const run = await runner.runPartial(automation(), 'B', { mode: 'only', triggerKind: 'manual_step' });
    assert.strictEqual(outputOf(run.id, 'B').to, 'old@example.org');
    assert.strictEqual(run.replaySource.runId, older.id);
});

test("the caller's payload wins, and is not reported as replayed", async () => {
    priorRun({ email: 'ada@example.org' });
    const run = await runner.runPartial(automation(), 'B', { mode: 'only', triggerKind: 'manual_step', triggerPayload: { email: 'given@example.org' } });
    assert.strictEqual(outputOf(run.id, 'B').to, 'given@example.org');
    assert.strictEqual(run.replaySource, undefined);
});

test('a pinned sample on the trigger wins over history', async () => {
    priorRun({ email: 'ada@example.org' });
    const run = await runner.runPartial(automation({ pinnedOutput: { email: 'pinned@example.org' } }), 'B', { mode: 'only', triggerKind: 'manual_step' });
    assert.strictEqual(outputOf(run.id, 'B').to, 'pinned@example.org');
    assert.strictEqual(run.replaySource, undefined);
});

test('no prior run: nothing to take, the trigger enters empty as before', async () => {
    const restore = configurePartialRuns({ executeAutomation: async (a, opts) => ({ id: 'run-x', status: 'success', opts }) });
    try {
        const run = await runner.runPartial(automation(), 'B', { mode: 'only', triggerKind: 'manual_step' });
        assert.strictEqual(run.opts.triggerPayload, null);
        assert.strictEqual(run.replaySource, undefined);
    } finally { restore(); }
});
