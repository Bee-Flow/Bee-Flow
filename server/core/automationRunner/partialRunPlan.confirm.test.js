/**
 * RM-9: a partial run WITHOUT a chosen run is planned too. A prerequisite of the
 * target that no recent live run has an output for is executed live to feed the
 * target (runDag fillMissingUpstream); when that prerequisite sends or writes,
 * the run is refused with 409 side_effects_need_confirm until the caller
 * confirms. A dry run leaves no replay data, so before this ▶ Execute after a dry
 * run mailed for real on every click. The target itself is what the author asked
 * to run and needs no confirm; a replayed or pinned prerequisite runs nothing.
 *
 * Run: cd server && node --test core/automationRunner/partialRunPlan.confirm.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');
const { installPartialRunHarness } = require('../automationRunner.partial.testkit');

const { runner, runStepsByRun, makeRun, reset } = installPartialRunHarness();
const { configurePartialRuns } = require('./partialRuns');
const { enforceUpstreamPlan, planPartialExecution } = require('./partialRunPlan');

const executed = [];
let restore = () => {};
beforeEach(() => {
    reset();
    executed.length = 0;
    restore = configurePartialRuns({ executeAutomation: async (a, opts) => { executed.push(opts); return { id: 'run-x', status: 'success' }; } });
});
after(() => { restore(); setImmediate(() => process.exit(process.exitCode || 0)); });

/** trigger → N (notification: sends) → T (set, the target) → W (notification after it). */
function automation({ pinN = false } = {}) {
    return {
        id: 'auto-1', version: 1, userId: 'user-1', organizationId: null, title: 'Upstream send', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'N', type: 'notification', title: 'Heads up', message: 'Sent', ...(pinN ? { pinnedOutput: { sent: true } } : {}) },
                { id: 'T', type: 'set', fields: { ok: { kind: 'literal', value: true } } },
                { id: 'W', type: 'notification', title: 'Done', message: 'Done' },
            ],
            edges: [{ from: 'trig', to: 'N' }, { from: 'N', to: 'T' }, { from: 'T', to: 'W' }],
        },
    };
}

async function rejects409(promise) {
    await assert.rejects(promise, (e) => {
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.code, 'side_effects_need_confirm');
        assert.deepStrictEqual(e.details.steps.map((s) => s.stepId), ['N']);
        assert.deepStrictEqual(e.details.missingUpstream, ['N']);
        return true;
    });
}

test('a sending prerequisite with no replayed output needs a confirm; nothing runs before it', async () => {
    await rejects409(runner.runPartial(automation(), 'T', { mode: 'only', triggerKind: 'manual_step' }));
    await rejects409(runner.runPartial(automation(), 'T', { mode: 'from', triggerKind: 'manual_step' }));
    assert.strictEqual(executed.length, 0);
});

test('with confirmSideEffects it runs', async () => {
    const run = await runner.runPartial(automation(), 'T', { mode: 'only', triggerKind: 'manual_step', confirmSideEffects: true });
    assert.strictEqual(run.status, 'success');
    assert.strictEqual(executed.length, 1);
    assert.strictEqual(executed[0].onlyStepId, 'T');
    // Without a chosen run the response carries no rerun plan (that stays the seeded re-run's).
    assert.strictEqual(run.rerunPlan, undefined);
});

test('a prerequisite a recent live run has an output for is replayed: no confirm', async () => {
    const prior = makeRun({ automationId: 'auto-1', version: 1, userId: 'user-1', triggerKind: 'manual', triggerPayload: null, mode: 'live' });
    runStepsByRun.get(prior.id).push({ runId: prior.id, stepId: 'N', parentStepId: null, stepType: 'notification', attempts: 1, status: 'success', output: { sent: true } });
    await runner.runPartial(automation(), 'T', { mode: 'only', triggerKind: 'manual_step' });
    assert.strictEqual(executed.length, 1);
});

test('a dry run leaves no replay data, so it does not lift the confirm', async () => {
    const dry = makeRun({ automationId: 'auto-1', version: 1, userId: 'user-1', triggerKind: 'dry_run', triggerPayload: null, mode: 'dry_run' });
    runStepsByRun.get(dry.id).push({ runId: dry.id, stepId: 'N', parentStepId: null, stepType: 'notification', attempts: 1, status: 'success', output: { _dryRun: true } });
    await rejects409(runner.runPartial(automation(), 'T', { mode: 'only', triggerKind: 'manual_step' }));
});

test('a pinned prerequisite runs nothing: no confirm', async () => {
    await runner.runPartial(automation({ pinN: true }), 'T', { mode: 'only', triggerKind: 'manual_step' });
    assert.strictEqual(executed.length, 1);
});

test('the target itself may send: that is what the author asked for', async () => {
    await runner.runPartial(automation(), 'N', { mode: 'only', triggerKind: 'manual_step' });
    assert.strictEqual(executed.length, 1);
});

test('"Run up to here" runs everything before the target on purpose: no plan, no confirm', async () => {
    await runner.runPartial(automation(), 'T', { mode: 'upTo', triggerKind: 'manual_step' });
    assert.strictEqual(executed.length, 1);
    assert.strictEqual(executed[0].untilStepId, 'T');
});

test('enforceUpstreamPlan: only missing prerequisites count, and the confirm lifts it', () => {
    const def = automation().definition;
    const plan = planPartialExecution(def, { targetId: 'T', mode: 'from', replayState: {} });
    // 'from' also runs W (a send) downstream: that is the run's own work, not a prerequisite.
    assert.deepStrictEqual(plan.sideEffects.map((s) => s.stepId), ['N', 'W']);
    assert.throws(() => enforceUpstreamPlan(plan, { confirmSideEffects: false }), (e) => {
        assert.deepStrictEqual(e.details.steps.map((s) => s.stepId), ['N']);
        return true;
    });
    assert.doesNotThrow(() => enforceUpstreamPlan(plan, { confirmSideEffects: true }));
    const replayed = planPartialExecution(def, { targetId: 'T', mode: 'from', replayState: { N: { output: { sent: true }, status: 'success' } } });
    assert.doesNotThrow(() => enforceUpstreamPlan(replayed, { confirmSideEffects: false }));
});
