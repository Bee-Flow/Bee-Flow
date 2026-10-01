/**
 * Run history for a "run once per item" step records what each item GOT.
 *
 * The confirmed scenario: dispatchStep resolved step.inputs against the OUTER
 * run state, where loop.<itemVar> is only bound inside execForEachStep's
 * per-item copy, so a step with inputs {to: loop.row.email} was recorded with
 * every mapped field empty, on success and on the error path alike, although
 * each item ran with the right value. Now the fan-out records the inputs of
 * its first 20 items itself (forEachInputSnapshot), and the dispatcher keeps
 * them.
 *
 * Run: cd server && node --test core/automationRunner/execution.forEachInputs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { installResolveStub } = require('../../testUtils/stubRequire');

process.env.NODE_ENV = 'test';

const recorded = [];
const storeStub = {
    createRun: async (row) => ({ id: 'run-1', ...row }),
    updateRun: async (id, patch) => ({ id, ...patch }),
    getRun: async (id) => ({ id, status: 'running' }),
    getAutomation: async () => null,
    getRunSteps: async () => [],
    getRunStepsForRuns: async () => [],
    getRunsForAutomation: async () => [],
    markRunning: async () => true,
    advanceSchedule: async () => {},
    getRunTokenMap: async () => ({}),
    recordRunStep: async (row) => { recorded.push(row); return { id: `step-${recorded.length}` }; },
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    touchAutomationRunning: async () => {},
    touchRunHeartbeat: async () => {},
    updateAutomation: async () => {},
};
const restore = installResolveStub({ '../../stores/automationStore': storeStub });
test.after(() => restore());

const { executeAutomation } = require(path.join(__dirname, 'execution.js'));
const { forEachInputSnapshot } = require('./execFlow');

const rows = (n) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.org` }));

function automation(n, stepOver = {}) {
    return {
        id: 'a1', name: 'per item', user_id: 'u1', organization_id: null, is_active: true,
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'src', type: 'set', fields: { rows: { kind: 'literal', value: rows(n) } } },
                {
                    id: 'each', type: 'integration_action', tool: 'gmail_send',
                    forEach: { overRef: 'steps.src.output.rows', itemVar: 'row', maxIterations: 100 },
                    inputs: { to: { kind: 'ref', path: 'loop.row.email' }, subject: { kind: 'template', value: 'Hi {{loop.row.email}}' } },
                    ...stepOver,
                },
            ],
            edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'each' }],
        },
    };
}

async function inputOf(stepId, auto) {
    recorded.length = 0;
    await executeAutomation(auto, { triggerKind: 'manual', mode: 'dry_run' });
    const rowsFor = recorded.filter(r => r.stepId === stepId);
    assert.ok(rowsFor.length, `no run step recorded for ${stepId}: ${JSON.stringify(recorded.map(r => r.stepId))}`);
    return rowsFor[rowsFor.length - 1].input;
}

test('each item\'s mapped inputs are recorded, not the empty outer-state resolve', async () => {
    const input = await inputOf('each', automation(3));
    assert.strictEqual(input.to, 'p0@example.org', 'the first item is what "Got in" lists');
    assert.strictEqual(input.subject, 'Hi p0@example.org');
    // The first item is the top level; _perItem holds the ones after it.
    assert.deepStrictEqual(input._perItem.map(p => p.inputs.to), ['p1@example.org', 'p2@example.org']);
    assert.deepStrictEqual(input._perItem.map(p => p.index), [1, 2]);
    assert.ok(!('_perItemOmitted' in input));
});

test('only the first 20 items are kept; the rest is counted', async () => {
    const input = await inputOf('each', automation(25));
    assert.strictEqual(input.to, 'p0@example.org');
    assert.strictEqual(input._perItem.length, 19);
    assert.strictEqual(input._perItem[18].inputs.to, 'p19@example.org');
    assert.strictEqual(input._perItemOmitted, 5);
});

test('a non-iterating step still records its inputs from the run state', async () => {
    const input = await inputOf('each', automation(2, { forEach: undefined, inputs: { n: { kind: 'ref', path: 'steps.src.output.rows[1].email' } } }));
    assert.deepStrictEqual(input, { n: 'p1@example.org' });
});

test('forEachInputSnapshot: nothing recorded is no snapshot, so the dispatcher falls back', () => {
    assert.strictEqual(forEachInputSnapshot([], 0), undefined);
    const snap = forEachInputSnapshot([{ a: 1 }, { a: 2 }], 2);
    assert.deepStrictEqual(snap, { a: 1, _perItem: [{ index: 1, inputs: { a: 2 } }] });
    assert.deepStrictEqual(forEachInputSnapshot([{ a: 1 }], 1), { a: 1 }, 'one item is just its inputs');
});

test('large shared inputs: the per-item list stays within budget and the top level survives truncation', async () => {
    // A ~15 KB text every item gets (steps.src.output.doc), as a forEach AI
    // step over a read document has. Twenty full copies used to push the
    // input past the 256 KB run-history cap, which then kept only a 1 KB head
    // sample of the WHOLE input.
    const doc = 'x'.repeat(15 * 1024);
    const auto = automation(25, { inputs: { to: { kind: 'ref', path: 'loop.row.email' }, content: { kind: 'ref', path: 'steps.src.output.doc' } } });
    auto.definition.steps[0].fields.doc = { kind: 'literal', value: doc };
    const input = await inputOf('each', auto);
    const { truncatePayload } = require('../../automation/payloadTruncation');
    const { value, truncated } = truncatePayload(input);
    assert.strictEqual(truncated, false, 'the recorded input fits the run-history cap');
    assert.strictEqual(value.to, 'p0@example.org');
    assert.strictEqual(value.content, doc, 'the shared input is kept at the top level');
    assert.ok(input._perItem.length > 0 && input._perItem.length < 19, `budgeted, got ${input._perItem.length}`);
    assert.strictEqual(input._perItem[0].index, 1);
    assert.strictEqual(input._perItemOmitted, 25 - 1 - input._perItem.length, 'every item not shown is counted');
});

test('when every item fails, the error row records the items\' inputs too', async () => {
    recorded.length = 0;
    await executeAutomation(automation(2, { tool: 'no_such_tool_anywhere' }), { triggerKind: 'manual', mode: 'live' });
    const errorRow = recorded.find(r => r.stepId === 'each' && r.status === 'error');
    assert.ok(errorRow, `expected an error row: ${JSON.stringify(recorded.map(r => [r.stepId, r.status, r.error]))}`);
    assert.strictEqual(errorRow.input.to, 'p0@example.org');
    assert.deepStrictEqual(errorRow.input._perItem.map(p => p.inputs.to), ['p1@example.org']);
});
