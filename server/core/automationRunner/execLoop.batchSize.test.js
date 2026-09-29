/**
 * Unit tests for execLoop's batchSize behavior (n8n-style Split-In-Batches).
 *
 * batchSize is OPTIONAL — omitted/1 must be byte-identical to the
 * pre-batching single-item behavior (automationRunner.flowlets.test.js
 * already locks that shape via execLoop directly). batchSize>1 slices the
 * source array into chunks and binds each chunk (an array) to
 * loop.<itemVar> instead of a single element.
 *
 * Heavy deps are pre-mocked via the require cache (same approach as
 * automationRunner.flowlets.test.js / automationRunner.aistep.test.js).
 *
 * Run: node --test core/automationRunner/execLoop.batchSize.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', {});
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

const { execLoop } = require('../automationRunner');

// Body step just echoes the bound loop var back out as its own output, so
// each iteration's `results[i].output` tells us exactly what was bound.
const echoBody = [{ id: 'echo', type: 'set', fields: { seen: { kind: 'ref', path: 'loop.item' } } }];
const dispatch = async (step, ctx, runState) => {
    if (step.type === 'set') {
        return { output: { seen: runState.loop?.item }, startedAt: new Date().toISOString(), inputSnapshot: null };
    }
    throw new Error(`unexpected step type in test body: ${step.type}`);
};

function baseState(items) {
    return { trigger: { output: { items } }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

test('batchSize omitted → unchanged single-item behavior (regression lock)', async () => {
    const step = { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100, body: echoBody };
    const { output } = await execLoop(step, {}, baseState([10, 20, 30]), 'live', dispatch);
    assert.strictEqual(output.iterations, 3);
    assert.deepStrictEqual(output.results.map(r => r.item), [10, 20, 30]);
    assert.deepStrictEqual(output.results.map(r => r.output.seen), [10, 20, 30]);
});

test('batchSize=1 explicit → same as omitted', async () => {
    const step = { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100, batchSize: 1, body: echoBody };
    const { output } = await execLoop(step, {}, baseState([10, 20, 30]), 'live', dispatch);
    assert.strictEqual(output.iterations, 3);
    assert.deepStrictEqual(output.results.map(r => r.item), [10, 20, 30]);
});

test('batchSize=3 slices into chunks and binds each chunk as an array', async () => {
    const step = { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100, batchSize: 3, body: echoBody };
    const items = [1, 2, 3, 4, 5, 6, 7];
    const { output } = await execLoop(step, {}, baseState(items), 'live', dispatch);
    // Math.ceil(7/3) = 3 iterations.
    assert.strictEqual(output.iterations, 3);
    assert.deepStrictEqual(output.results.map(r => r.item), [[1, 2, 3], [4, 5, 6], [7]]);
    assert.deepStrictEqual(output.results.map(r => r.output.seen), [[1, 2, 3], [4, 5, 6], [7]]);
});

test('batchSize evenly divides the array with no short final batch', async () => {
    const step = { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100, batchSize: 2, body: echoBody };
    const { output } = await execLoop(step, {}, baseState([1, 2, 3, 4]), 'live', dispatch);
    assert.strictEqual(output.iterations, 2);
    assert.deepStrictEqual(output.results.map(r => r.item), [[1, 2], [3, 4]]);
});

test('a non-numeric or zero batchSize falls back to 1 (never divides by zero / NaN iterations)', async () => {
    for (const bad of [0, -5, 'x', null]) {
        const step = { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100, batchSize: bad, body: echoBody };
        const { output } = await execLoop(step, {}, baseState([1, 2]), 'live', dispatch);
        assert.strictEqual(output.iterations, 2, `batchSize=${bad} should behave as 1`);
    }
});
