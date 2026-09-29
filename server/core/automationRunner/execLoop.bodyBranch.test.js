/**
 * Loop-body branchers — node-audit C3 (critical).
 *
 * `execLoop` synthesizes a linear sub-DAG for its body, but used to emit only
 * UNLABELLED edges. runDag routes a condition/switch by the label its executor
 * returns, and an unlabelled edge only matches plain on_success — so every
 * body step after an If/Switch silently dead-ended, every iteration.
 *
 * The contract now:
 *   - condition in a body = GUARD: `then` continues, `else` ends the iteration
 *     (same semantics as the "Filter (route)" palette item);
 *   - switch in a body = pass-through: all declared cases + default continue.
 *
 * Run: node --test core/automationRunner/execLoop.bodyBranch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', { createNotification: async () => ({}) });
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

const { buildLinearEdges, execLoop, execCondition, execSwitch } = require('../automationRunner');

// ── buildLinearEdges unit contract ───────────────────────────────────────────

test('plain steps chain with unlabelled edges (unchanged)', () => {
    const edges = buildLinearEdges([{ id: 'a', type: 'set' }, { id: 'b', type: 'set' }]);
    assert.deepStrictEqual(edges, [
        { from: '__loop_root__', to: 'a' },
        { from: 'a', to: 'b' },
    ]);
});

test('a condition in the body emits a then-labelled edge to the next step', () => {
    const edges = buildLinearEdges([
        { id: 'c', type: 'condition', expr: 'true' },
        { id: 'n', type: 'notification' },
    ]);
    assert.deepStrictEqual(edges.find(e => e.from === 'c'), { from: 'c', to: 'n', label: 'then' });
});

test('a switch in the body emits one edge per declared case plus case:default', () => {
    const edges = buildLinearEdges([
        { id: 'sw', type: 'switch', expr: 'x', cases: [{ name: 'a' }, { name: 'b' }] },
        { id: 'n', type: 'notification' },
    ]);
    const fromSw = edges.filter(e => e.from === 'sw').map(e => e.label).sort();
    assert.deepStrictEqual(fromSw, ['case:a', 'case:b', 'case:default']);
});

test('a brancher as the LAST body step emits no outgoing edges', () => {
    const edges = buildLinearEdges([{ id: 'x', type: 'set' }, { id: 'c', type: 'condition', expr: 'true' }]);
    assert.strictEqual(edges.filter(e => e.from === 'c').length, 0);
});

// ── End-to-end through execLoop ──────────────────────────────────────────────

// Minimal dispatcher: notifications record themselves; branchers run their
// REAL executors so branch labels are computed exactly as in production.
function makeCtx(ran) {
    const dispatch = async (step, ctx, runState, mode) => {
        if (step.type === 'condition') return { ...(await execCondition(step, ctx, runState, mode)), startedAt: new Date().toISOString() };
        if (step.type === 'switch') return { ...(await execSwitch(step, ctx, runState, mode)), startedAt: new Date().toISOString() };
        ran.push(step.id);
        return { output: { ranId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null };
    };
    return dispatch;
}

function loopState(items) {
    return { trigger: { output: { items } }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

const loopStep = (body) => ({
    id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100, body,
});

test('body steps AFTER a true condition run on every iteration', async () => {
    const ran = [];
    const step = loopStep([
        { id: 'guard', type: 'condition', expr: 'true' },
        { id: 'after', type: 'notification', title: 'x' },
    ]);
    const res = await execLoop(step, {}, loopState([1, 2]), 'live', makeCtx(ran));
    assert.strictEqual(res.output.iterations, 2);
    assert.deepStrictEqual(ran, ['after', 'after']);
});

test('a false condition ends the iteration: later body steps never run, but iterations still complete', async () => {
    const ran = [];
    const step = loopStep([
        { id: 'guard', type: 'condition', expr: 'false' },
        { id: 'after', type: 'notification', title: 'x' },
    ]);
    const res = await execLoop(step, {}, loopState([1, 2]), 'live', makeCtx(ran));
    assert.strictEqual(res.output.iterations, 2);
    assert.deepStrictEqual(ran, [], 'guard blocked the tail on every iteration');
});

test('a per-item guard passes only matching items through', async () => {
    const ran = [];
    const step = loopStep([
        { id: 'guard', type: 'condition', expr: 'loop.item > 1' },
        { id: 'after', type: 'notification', title: 'x' },
    ]);
    await execLoop(step, {}, loopState([1, 2, 3]), 'live', makeCtx(ran));
    assert.deepStrictEqual(ran, ['after', 'after'], 'items 2 and 3 pass, item 1 is guarded out');
});

test('body steps after a switch run regardless of which case matched', async () => {
    const ran = [];
    const step = loopStep([
        { id: 'sw', type: 'switch', expr: 'loop.item', cases: [{ name: 'one', value: 1 }] },
        { id: 'after', type: 'notification', title: 'x' },
    ]);
    // item 1 matches case "one"; item 99 matches nothing → default path.
    await execLoop(step, {}, loopState([1, 99]), 'live', makeCtx(ran));
    assert.deepStrictEqual(ran, ['after', 'after'], 'both the matched-case and default paths continue');
});
