/**
 * runDag fan-in gating — node-audit C2 (critical).
 *
 * The join gate used to initialise every target's pending-predecessor count
 * from ALL edges in the definition. Two ways that deadlocked:
 *
 *   1. Multi-trigger convergence: a step wired from BOTH the primary trigger
 *      and a secondary webhook/app-event trigger. A run seeded from one
 *      trigger never dispatches the other, so the other's edge never
 *      resolved and the shared step never fired — the run drained and
 *      finished "success" having executed NOTHING.
 *   2. Dead-branch joins: a join one of whose feeders sits on the untaken
 *      branch of a condition/switch, two or more levels up. A never-
 *      dispatched node never called advance, so dead-ness didn't cascade.
 *
 * Fix: predecessor counts include only edges whose source is REACHABLE from
 * the seeded root, and `advance` is a worklist that cascades dead-ness
 * through never-dispatched nodes.
 *
 * Run: node --test core/automationRunner/runDag.fanIn.test.js
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

const { runDag } = require('../automationRunner');

function baseState() {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

/**
 * Dispatcher that records execution order and lets branchers pick a branch.
 * `branches` maps step id → the raw branch label runDag routes on
 * ('then'/'else' for a condition, 'case:<name>' for a switch) — the real
 * executors compute this in output.branch, and this stub stands in for them.
 */
function makeDispatcher(branches = {}) {
    const ran = [];
    const dispatch = async (step) => {
        ran.push(step.id);
        if (step.type === 'condition' || step.type === 'switch') {
            const branch = branches[step.id] || (step.type === 'condition' ? 'then' : 'case:default');
            return { output: { branch, value: branch === 'then' }, startedAt: new Date().toISOString(), inputSnapshot: null };
        }
        return { output: { ranId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null };
    };
    return { ran, dispatch };
}

const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });

// ── Multi-trigger convergence ────────────────────────────────────────────────

const convergentDef = () => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [note('shared')],
    edges: [
        { from: 'trg', to: 'shared' },
        { from: 'trg2', to: 'shared' },
    ],
    triggers: [{ id: 'trg2', kind: 'webhook' }],
});

test('a step wired from BOTH triggers runs when seeded from the primary', async () => {
    const { ran, dispatch } = makeDispatcher();
    await runDag(convergentDef(), {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['shared']);
});

test('a step wired from BOTH triggers runs when seeded from the secondary (rootStepId)', async () => {
    const { ran, dispatch } = makeDispatcher();
    await runDag(convergentDef(), {}, baseState(), 'live', dispatch, { recordSteps: false, rootStepId: 'trg2' });
    assert.deepStrictEqual(ran, ['shared']);
});

test('downstream of the shared step also runs (deadlock did not just move)', async () => {
    const def = convergentDef();
    def.steps.push(note('after'));
    def.edges.push({ from: 'shared', to: 'after' });
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['shared', 'after']);
});

// ── Dead-branch cascade ──────────────────────────────────────────────────────

test('diamond: a join fires once with only the taken branch (single-level dead branch)', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'c', type: 'condition', expr: 'false' },
            note('a'), note('b'), note('j'),
        ],
        edges: [
            { from: 'trg', to: 'c' },
            { from: 'c', to: 'a', label: 'then' },
            { from: 'c', to: 'b', label: 'else' },
            { from: 'a', to: 'j' },
            { from: 'b', to: 'j' },
        ],
    };
    const { ran, dispatch } = makeDispatcher({ c: 'else' });
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['c', 'b', 'j'], 'else-branch + join, then-branch dead');
    assert.strictEqual(ran.filter(id => id === 'j').length, 1, 'join must fire exactly once');
});

test('dead-ness cascades through a multi-step dead chain into a join', async () => {
    // c(else) → j directly; c(then) → a1 → a2 → j. With expr false, a1/a2
    // never dispatch — their edges must still resolve or j deadlocks.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'c', type: 'condition', expr: 'false' },
            note('a1'), note('a2'), note('j'),
        ],
        edges: [
            { from: 'trg', to: 'c' },
            { from: 'c', to: 'a1', label: 'then' },
            { from: 'c', to: 'j', label: 'else' },
            { from: 'a1', to: 'a2' },
            { from: 'a2', to: 'j' },
        ],
    };
    const { ran, dispatch } = makeDispatcher({ c: 'else' });
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['c', 'j']);
});

test('a join whose feeders are BOTH dead stays dead (no spurious dispatch)', async () => {
    // Both branch targets feed j2; the condition routes to a third path.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'sw', type: 'switch', expr: '"z"', cases: [{ name: 'a', value: 'a' }, { name: 'b', value: 'b' }], defaultBranch: null },
            note('pa'), note('pb'), note('j2'), note('dflt'),
        ],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'pa', label: 'case:a', caseName: 'a' },
            { from: 'sw', to: 'pb', label: 'case:b', caseName: 'b' },
            { from: 'sw', to: 'dflt', label: 'case:default', caseName: 'default' },
            { from: 'pa', to: 'j2' },
            { from: 'pb', to: 'j2' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.ok(ran.includes('dflt'), 'default path runs');
    assert.ok(!ran.includes('j2'), 'join fed only by dead branches must not run');
    assert.ok(!ran.includes('pa') && !ran.includes('pb'));
});

// ── Regression guards ────────────────────────────────────────────────────────

test('unequal-depth join still waits for the longer branch (original fan-in contract)', async () => {
    // trg → c; c-then→ s1 → s2 → j; c-else→ j …with BOTH branches taken is
    // impossible for a condition, so use a plain fork: trg → x, trg → y1 → y2,
    // x → j, y2 → j. j must fire once, after both.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [note('x'), note('y1'), note('y2'), note('j')],
        edges: [
            { from: 'trg', to: 'x' },
            { from: 'trg', to: 'y1' },
            { from: 'y1', to: 'y2' },
            { from: 'x', to: 'j' },
            { from: 'y2', to: 'j' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.strictEqual(ran.filter(id => id === 'j').length, 1);
    assert.strictEqual(ran.indexOf('j'), ran.length - 1, 'join runs last');
});

test('single-trigger linear flow unchanged (byte-identical baseline)', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [note('n1'), note('n2')],
        edges: [{ from: 'trg', to: 'n1' }, { from: 'n1', to: 'n2' }],
    };
    const { ran, dispatch } = makeDispatcher();
    const result = await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['n1', 'n2']);
    assert.deepStrictEqual(result.lastOutput, { ranId: 'n2' });
});
