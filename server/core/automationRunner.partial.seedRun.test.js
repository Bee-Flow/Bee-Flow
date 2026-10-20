/**
 * Re-run a step with the inputs of a CHOSEN run (partial run with `seedRunId`).
 *
 * Without a seed run a partial run rebuilds its upstream data from the last ten
 * runs (replay.test.js). With one it takes exactly that run's recorded outputs:
 *
 *   - the chosen run, not the newest one, decides the data, and is the parent;
 *   - a run of another automation, one that does not exist and one whose data
 *     the caller may not read all answer the same 404;
 *   - a step the chosen run has no output for is refused (409
 *     seed_missing_upstream) unless the caller allows it to run live;
 *   - steps that send or write need an explicit yes (409
 *     side_effects_need_confirm) and are listed in the answer;
 *   - a run from an older definition version is reported as stale;
 *   - without seedRunId nothing changes.
 *
 * Pure in-process `set` steps keep the executed cases deterministic; the
 * confirmation cases swap the executor through configurePartialRuns so no
 * notification is ever sent.
 *
 * Run: node --test core/automationRunner.partial.seedRun.test.js
 */

const { test, after } = require('node:test');
require('../automation/runnerPorts');
require('../integrations/runnerPorts');
require('../services/runnerPorts');
const assert = require('node:assert');

const { installPartialRunHarness } = require('./automationRunner.partial.testkit');

let priorRuns = [];              // NEWEST first
const { runner, runStepsByRun, makeRun, storeStub, reset: resetHarness } = installPartialRunHarness({
    getRunsForAutomation: async (automationId, { limit = 50 } = {}) =>
        priorRuns.filter(r => r.automationId === automationId).slice(0, limit),
});
const { configurePartialRuns } = require('./automationRunner/partialRuns');
const { planPartialExecution } = require('./automationRunner/partialRunPlan');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

// trigger → A → B → N, with N a notification (a step that sends).
function automation({ version = 1 } = {}) {
    return {
        id: 'auto-1',
        version,
        userId: 'user-1',
        organizationId: null,
        title: 'Seeded re-run',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                { id: 'A', type: 'set', fields: { value: { kind: 'literal', value: 21 } } },
                { id: 'B', type: 'set', fields: { doubled: { kind: 'expr', value: 'steps.A.output.value * 2' } } },
                { id: 'N', type: 'notification', title: 'done' },
            ],
            edges: [{ from: 'trig', to: 'A' }, { from: 'A', to: 'B' }, { from: 'B', to: 'N' }],
        },
    };
}

function reset() { resetHarness(); priorRuns = []; }

function seedRun({ automationId = 'auto-1', mode = 'live', version = 1, extra = {}, steps = [] }) {
    const row = makeRun({ automationId, version, userId: 'user-1', triggerKind: 'manual', mode });
    row.status = 'success';
    Object.assign(row, extra);
    for (const s of steps) {
        runStepsByRun.get(row.id).push({
            runId: row.id, parentStepId: null, attempts: 1, stepType: 'set',
            startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
            input: null, output: null, error: null, errorClass: null, branchIndex: null,
            ...s,
        });
    }
    priorRuns.unshift(row);
    return row;
}

const stepsOf = async (runId) => new Map((await storeStub.getRunSteps(runId)).map(s => [s.stepId, s]));

async function rejects(promise, status, code) {
    await assert.rejects(promise, (e) => {
        assert.strictEqual(e.status, status, `status ${e.status} (${e.message})`);
        assert.strictEqual(e.code, code);
        return true;
    });
}

test('the chosen run seeds the step, not the newest one, and becomes its parent', async () => {
    reset();
    const chosen = seedRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 5 } }] });
    seedRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 100 } }] }); // newer

    const result = await runner.runPartial(automation(), 'B', { mode: 'only', seedRunId: chosen.id });
    assert.strictEqual(result.status, 'success', `status ${result.status} / ${result.error}`);
    assert.strictEqual(result.parentRunId, chosen.id);
    const byId = await stepsOf(result.id);
    assert.ok(!byId.has('A'), 'A was replayed from the chosen run, not executed');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 10 }, 'B used 5 from the chosen run, not 100 from the newest');
    assert.deepStrictEqual(result.rerunPlan.willExecute, ['B']);
    assert.deepStrictEqual(result.rerunPlan.missingUpstream, []);
    assert.strictEqual(result.rerunPlan.seedRunId, chosen.id);
});

test('the whole journey seeds the step: an output recorded on an earlier leg is found from the continuation leg', async () => {
    reset();
    const first = seedRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 7 } }] });
    // The continuation after a pause records only the steps it dispatched live.
    const second = seedRun({ extra: { rootRunId: first.id, parentRunId: first.id }, steps: [{ stepId: 'N', status: 'success', output: {} }] });

    const plan = await runner.planPartialRun(automation(), 'B', { mode: 'only', seedRunId: second.id });
    assert.deepStrictEqual(plan.missingUpstream, [], 'A was recorded on the first leg');
    const result = await runner.runPartial(automation(), 'B', { mode: 'only', seedRunId: second.id });
    assert.strictEqual(result.status, 'success', `status ${result.status} / ${result.error}`);
    assert.strictEqual(result.parentRunId, second.id, 'the opened run stays the parent');
    assert.deepStrictEqual((await stepsOf(result.id)).get('B')?.output, { doubled: 14 });
});

test('a later leg overrides an earlier one, and a leg whose data the viewer may not read stays out', async () => {
    reset();
    const first = seedRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 1 } }] });
    const second = seedRun({ extra: { rootRunId: first.id }, steps: [{ stepId: 'A', status: 'success', attempts: 2, output: { value: 2 } }] });
    const hidden = seedRun({
        extra: { rootRunId: first.id, connectionsMode: 'caller', startedByUserId: 'starter' },
        steps: [{ stepId: 'A', status: 'success', attempts: 3, output: { value: 300 } }],
    });
    // The viewer reads the first two legs, not the third.
    const result = await runner.runPartial(automation(), 'B', { mode: 'only', seedRunId: second.id, startedByUserId: 'owner' });
    assert.deepStrictEqual((await stepsOf(result.id)).get('B')?.output, { doubled: 4 });
    // The hidden leg's own starter sees all three, the newest leg last.
    const own = await runner.runPartial(automation(), 'B', { mode: 'only', seedRunId: hidden.id, startedByUserId: 'starter' });
    assert.deepStrictEqual((await stepsOf(own.id)).get('B')?.output, { doubled: 600 });
});

test('a run of another automation answers 404, exactly like a run that does not exist', async () => {
    reset();
    const other = seedRun({ automationId: 'auto-2', steps: [{ stepId: 'A', status: 'success', output: { value: 5 } }] });
    await rejects(runner.runPartial(automation(), 'B', { seedRunId: other.id }), 404, 'seed_run_not_found');
    await rejects(runner.runPartial(automation(), 'B', { seedRunId: 'no-such-run' }), 404, 'seed_run_not_found');
});

test('a run on somebody else\'s own connections answers 404; its starter can use it', async () => {
    reset();
    const mine = seedRun({
        extra: { connectionsMode: 'caller', startedByUserId: 'starter' },
        steps: [{ stepId: 'A', status: 'success', output: { value: 3 } }],
    });
    await rejects(runner.runPartial(automation(), 'B', { seedRunId: mine.id, startedByUserId: 'owner' }), 404, 'seed_run_not_found');
    const result = await runner.runPartial(automation(), 'B', { seedRunId: mine.id, startedByUserId: 'starter' });
    assert.deepStrictEqual((await stepsOf(result.id)).get('B')?.output, { doubled: 6 });
});

test('a dry run is refused: its outputs are samples', async () => {
    reset();
    const dry = seedRun({ mode: 'dry_run', steps: [{ stepId: 'A', status: 'success', output: { value: 9 } }] });
    await rejects(runner.runPartial(automation(), 'B', { seedRunId: dry.id }), 409, 'seed_run_synthetic');
});

test('a step the chosen run has no output for is refused, and runs live when allowed', async () => {
    reset();
    const chosen = seedRun({ steps: [{ stepId: 'S', status: 'success', output: { x: 1 } }] }); // no A row
    await assert.rejects(runner.runPartial(automation(), 'B', { seedRunId: chosen.id }), (e) => {
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.code, 'seed_missing_upstream');
        assert.deepStrictEqual(e.details, { stepIds: ['A'] });
        return true;
    });
    assert.strictEqual([...runStepsByRun.values()].flat().filter(s => s.stepId === 'B').length, 0, 'nothing ran');

    const result = await runner.runPartial(automation(), 'B', { seedRunId: chosen.id, allowLiveUpstream: true });
    const byId = await stepsOf(result.id);
    assert.deepStrictEqual(byId.get('A')?.output, { value: 21 }, 'A executed live');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 42 });
    assert.deepStrictEqual(result.rerunPlan.missingUpstream, ['A']);
});

test('a truncated row is read back from its full copy; one without a copy counts as missing', async () => {
    reset();
    const chosen = seedRun({ steps: [] });
    const ref = { runId: chosen.id, stepId: 'A', attempts: 1 };
    runStepsByRun.get(chosen.id).push({
        runId: chosen.id, stepId: 'A', parentStepId: null, attempts: 1, stepType: 'set', status: 'success',
        output: { __truncated__: true, originalBytes: 1_500_000, fullOutputRef: ref },
    });
    storeStub.getRunFullOutput = async (runId, stepId, attempts) => (runId === chosen.id && stepId === 'A' && attempts === 1 ? { value: 8 } : null);
    try {
        const result = await runner.runPartial(automation(), 'B', { seedRunId: chosen.id });
        assert.deepStrictEqual((await stepsOf(result.id)).get('B')?.output, { doubled: 16 });
        storeStub.getRunFullOutput = async () => null;
        await rejects(runner.runPartial(automation(), 'B', { seedRunId: chosen.id }), 409, 'seed_missing_upstream');
    } finally {
        delete storeStub.getRunFullOutput;
    }
});

test('steps that send need a confirmation: 409 with the list, then success', async () => {
    reset();
    const chosen = seedRun({ steps: [
        { stepId: 'A', status: 'success', output: { value: 5 } },
        { stepId: 'B', status: 'success', output: { doubled: 10 } },
    ] });
    const executed = [];
    const restore = configurePartialRuns({
        executeAutomation: async (a, opts) => { executed.push(opts); return { id: 'run-x', status: 'success', parentRunId: opts.parentRunId }; },
    });
    try {
        await assert.rejects(runner.runPartial(automation(), 'N', { mode: 'only', seedRunId: chosen.id }), (e) => {
            assert.strictEqual(e.status, 409);
            assert.strictEqual(e.code, 'side_effects_need_confirm');
            assert.deepStrictEqual(e.details.steps, [{ stepId: 'N', type: 'notification', tool: null, label: null, effect: 'sends' }]);
            return true;
        });
        assert.strictEqual(executed.length, 0, 'nothing executed without the confirmation');

        const result = await runner.runPartial(automation(), 'N', { mode: 'only', seedRunId: chosen.id, confirmSideEffects: true });
        assert.strictEqual(executed.length, 1);
        assert.strictEqual(executed[0].onlyStepId, 'N');
        assert.strictEqual(executed[0].parentRunId, chosen.id);
        assert.strictEqual(result.rerunPlan.requiresConfirm, true);
        assert.deepStrictEqual(result.rerunPlan.willExecute, ['N']);
    } finally { restore(); }
});

test('mode "from" counts everything downstream, and "upTo" has no seed to take', async () => {
    reset();
    const chosen = seedRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 5 } }] });
    const restore = configurePartialRuns({ executeAutomation: async () => { throw new Error('must not execute'); } });
    try {
        const plan = await runner.planPartialRun(automation(), 'B', { mode: 'from', seedRunId: chosen.id });
        assert.deepStrictEqual(plan.willExecute, ['B', 'N']);
        assert.deepStrictEqual(plan.sideEffects.map(s => s.stepId), ['N']);
        await rejects(runner.runPartial(automation(), 'B', { mode: 'upTo', seedRunId: chosen.id }), 400, 'seed_mode_unsupported');
    } finally { restore(); }
});

test('planPartialRun reports the plan and runs nothing, even when a confirmation would be needed', async () => {
    reset();
    const chosen = seedRun({ version: 1, steps: [{ stepId: 'A', status: 'success', output: { value: 5 } }] });
    const before = [...priorRuns].length;
    const plan = await runner.planPartialRun(automation({ version: 3 }), 'N', { seedRunId: chosen.id });
    assert.deepStrictEqual(plan.missingUpstream, ['B']);
    assert.deepStrictEqual(plan.willExecute, ['B', 'N']);
    assert.strictEqual(plan.requiresConfirm, true);
    assert.deepStrictEqual(plan.replayStale, [{ stepId: 'A', version: 1 }]);
    assert.strictEqual(plan.seedRunVersion, 1);
    assert.strictEqual([...runStepsByRun.values()].length, before, 'no run was created');
});

test('a run from an older definition version is flagged stale on the executed run too', async () => {
    reset();
    const chosen = seedRun({ version: 1, steps: [{ stepId: 'A', status: 'success', output: { value: 5 } }] });
    const result = await runner.runPartial(automation({ version: 2 }), 'B', { seedRunId: chosen.id });
    assert.deepStrictEqual(result.replayStale, [{ stepId: 'A', version: 1 }]);
    assert.deepStrictEqual(result.rerunPlan.replayStale, [{ stepId: 'A', version: 1 }]);
});

test('without seedRunId nothing changes: the newest run wins, no plan, no refusal', async () => {
    reset();
    seedRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 5 } }] });
    seedRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 100 } }] });
    const result = await runner.runPartial(automation(), 'B', { mode: 'only' });
    assert.strictEqual(result.rerunPlan, undefined);
    assert.deepStrictEqual((await stepsOf(result.id)).get('B')?.output, { doubled: 200 });

    // A step that sends runs without any confirmation, as before.
    const restore = configurePartialRuns({ executeAutomation: async (a, opts) => ({ id: 'run-y', status: 'success', opts }) });
    try {
        const sent = await runner.runPartial(automation(), 'N', { mode: 'only', allowLiveUpstream: false });
        assert.strictEqual(sent.status, 'success');
        assert.strictEqual(sent.rerunPlan, undefined);
    } finally { restore(); }
});

test('planPartialExecution: a pinned step is not missing, a sibling branch is not named', () => {
    const graph = {
        trigger: { id: 'trig' },
        steps: [
            { id: 'A', type: 'set' }, { id: 'B', type: 'set' },
            { id: 'S', type: 'notification' },
        ],
        edges: [{ from: 'trig', to: 'A' }, { from: 'A', to: 'B' }, { from: 'trig', to: 'S' }],
    };
    const plan = planPartialExecution(graph, { targetId: 'B', mode: 'only', replayState: { A: { output: { v: 1 }, status: 'success' } } });
    assert.deepStrictEqual(plan, { willExecute: ['B'], missingUpstream: [], sideEffects: [] });
    const open = planPartialExecution(graph, { targetId: 'B', mode: 'only', replayState: {} });
    assert.deepStrictEqual(open.missingUpstream, ['A']);
    assert.deepStrictEqual(open.willExecute, ['A', 'B']);
    assert.deepStrictEqual(open.sideEffects, [], 'the sibling notification is not part of this run');
});

// ── a step inside a flowlet takes the chosen run's inputs too ─────────────

function automationWithLayer() {
    return {
        id: 'auto-1', version: 1, userId: 'user-1', organizationId: null, title: 'Layer', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'L1', inputs: { x: { kind: 'literal', value: 'root-val' } } }],
            edges: [{ from: 'trig', to: 'cl1' }],
            layers: {
                L1: {
                    trigger: { id: 'li1', type: 'trigger', kind: 'layer_input', params: [{ name: 'x', type: 'string' }] },
                    steps: [
                        { id: 'A', type: 'set', fields: { echoed: { kind: 'ref', path: 'trigger.output.x' } } },
                        { id: 'B', type: 'set', fields: { shout: { kind: 'expr', value: 'steps.A.output.echoed' } } },
                    ],
                    edges: [{ from: 'li1', to: 'A' }, { from: 'A', to: 'B' }],
                },
            },
        },
    };
}

test('inside a flowlet: the chosen run seeds the layer steps, and a gap is refused', async () => {
    reset();
    const chosen = seedRun({ steps: [{ stepId: 'A', status: 'success', output: { echoed: 'from-chosen' } }] });
    seedRun({ steps: [{ stepId: 'A', status: 'success', output: { echoed: 'from-newest' } }] });
    const result = await runner.runPartial(automationWithLayer(), 'B', { mode: 'only', seedRunId: chosen.id, triggerPayload: { x: 'p' } });
    assert.strictEqual(result.status, 'success', `status ${result.status} / ${result.error}`);
    assert.deepStrictEqual((await stepsOf(result.id)).get('B')?.output, { shout: 'from-chosen' });
    assert.deepStrictEqual(result.rerunPlan.willExecute, ['B']);

    const empty = seedRun({ steps: [] });
    await assert.rejects(runner.runPartial(automationWithLayer(), 'B', { mode: 'only', seedRunId: empty.id, triggerPayload: { x: 'p' } }), (e) => {
        assert.strictEqual(e.code, 'seed_missing_upstream');
        assert.deepStrictEqual(e.details, { stepIds: ['A'] });
        return true;
    });
});
