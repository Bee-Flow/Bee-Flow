/**
 * Regression test for the runDag fan-in (join) race: a step with multiple
 * incoming edges from branches of UNEQUAL depth used to dispatch as soon as
 * the SHORTEST branch's edge landed in the queue, because `visited` was set
 * the instant a node was first dequeued — the second (longer) branch's edge
 * arrived later and was silently dropped by the `visited.has(id)` guard,
 * so the join step ran with only the short branch's data in runState.
 *
 * Graph:
 *   trg --> A -------------------> C   (depth 1)
 *   trg --> X --> Y --> B -------> C   (depth 3)
 *
 * Without the fix, C would dispatch right after A (queue order [X, C] means
 * C is dequeued before Y/B ever run). With the fix, C only dispatches once
 * BOTH A and B have completed and written into runState.steps.
 *
 * Run: node --test core/automationRunner.joinrace.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../stores/automationStore', {
    getAutomation: async () => null,
    recordRunStep: async () => {},
});
mock('../stores/configStore', {});
mock('../stores/notificationStore', {});
mock('../db', { pool: {} });
mock('./aiAgent', { getProviderForModel: async () => null });
mock('./providers', { getAdapter: () => ({}) });
mock('../automation/codeSandbox', { run: async () => ({}) });

const runner = require('./automationRunner');

function diamondDef() {
    return {
        trigger: { id: 'trg', type: 'trigger' },
        steps: [
            { id: 'A', type: 'set' },
            { id: 'X', type: 'set' },
            { id: 'Y', type: 'set' },
            { id: 'B', type: 'set' },
            { id: 'C', type: 'set' },
        ],
        edges: [
            { from: 'trg', to: 'A' },
            { from: 'trg', to: 'X' },
            { from: 'A', to: 'C' },
            { from: 'X', to: 'Y' },
            { from: 'Y', to: 'B' },
            { from: 'B', to: 'C' },
        ],
    };
}

test('runDag: join step waits for ALL incoming branches, even when they have unequal depth', async () => {
    let seenAtC = null;
    const dispatch = async (step, ctx, runState) => {
        if (step.id === 'C') {
            // Snapshot exactly what upstream data is visible the moment C
            // is dispatched — this is the assertion that matters.
            seenAtC = Object.keys(runState.steps || {}).sort();
        }
        return { output: { stepId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null };
    };

    const runState = { steps: {}, trigger: { output: {} } };
    await runner.runDag(diamondDef(), { runId: null }, runState, 'live', dispatch, { recordSteps: false });

    assert.ok(seenAtC, 'C must have been dispatched');
    assert.deepStrictEqual(
        seenAtC,
        ['A', 'B', 'X', 'Y'],
        'C must see A, X, Y, AND B already recorded — not just the short branch (A)',
    );
});

test('runDag: a step reachable only via an untaken condition branch never dispatches (no deadlock)', async () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger' },
        steps: [
            { id: 'cond', type: 'condition' },
            { id: 'thenStep', type: 'set' },
            { id: 'elseStep', type: 'set' },
        ],
        edges: [
            { from: 'trg', to: 'cond' },
            { from: 'cond', to: 'thenStep', label: 'then' },
            { from: 'cond', to: 'elseStep', label: 'else' },
        ],
    };
    const dispatchedIds = [];
    const dispatch = async (step) => {
        dispatchedIds.push(step.id);
        if (step.id === 'cond') {
            return { output: { branch: 'then' }, startedAt: new Date().toISOString(), inputSnapshot: null };
        }
        return { output: {}, startedAt: new Date().toISOString(), inputSnapshot: null };
    };
    const runState = { steps: {}, trigger: { output: {} } };
    await runner.runDag(def, { runId: null }, runState, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(dispatchedIds.sort(), ['cond', 'thenStep'], 'elseStep (untaken branch) must never dispatch, and must not deadlock the walk');
});
