/**
 * BFSF-411 — the execution-layer guarantee for a `note` step (a free-floating
 * canvas annotation): a definition containing one must NEVER throw "Unknown
 * step type", and the note must NEVER appear as a dispatched/executed step.
 *
 * Two levels, matching the two places a note could otherwise reach dispatch:
 *   - top-level (runDag) — a note carries no edges, so it is never enqueued
 *     at all; proven here by a fake dispatcher that FAILS the test if it is
 *     ever called with one.
 *   - nested in a loop body (execFlow's buildLinearEdges synthesizes a linear
 *     chain for the body regardless of what the author drew — the one place
 *     a step could get an edge it never asked for) — proven the same way.
 *
 * Run: node --test core/automationRunner/note.dispatch.test.js
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

const { runDag, buildLinearEdges, execLoop } = require('../automationRunner');

function baseState() {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

/** Fails the test the instant it is asked to dispatch a note. */
function failOnNoteDispatch(ran) {
    return async (step) => {
        if (step.type === 'note') {
            throw new Error(`note step "${step.id}" was dispatched — it must never be, and its type must never reach an "Unknown step type" throw`);
        }
        ran.push(step.id);
        return { output: { ranId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null };
    };
}

test('a top-level note carries no edges, so runDag never enqueues it', async () => {
    const ran = [];
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'n1', type: 'notification', title: 'hi' },
            // Isolated — no edge in or out, exactly what applyAddNote /
            // buildStepFromPayload produce.
            { id: 'note_1', type: 'note', text: 'why this branch exists' },
        ],
        edges: [{ from: 'trg', to: 'n1' }],
    };
    const result = await runDag(def, {}, baseState(), 'live', failOnNoteDispatch(ran), { recordSteps: false });
    assert.deepStrictEqual(result.lastOutput, { ranId: 'n1' });
    assert.deepStrictEqual(ran, ['n1'], 'only the real step ran');
});

test('a definition with ONLY a note (plus a trigger) completes with nothing dispatched', async () => {
    const ran = [];
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'note_1', type: 'note', text: 'todo: wire something here' }],
        edges: [],
    };
    const result = await runDag(def, {}, baseState(), 'live', failOnNoteDispatch(ran), { recordSteps: false });
    assert.strictEqual(result.lastOutput, null);
    assert.deepStrictEqual(ran, []);
});

// ── buildLinearEdges: the one place a step's edges are SYNTHESIZED ──────────
// (loop bodies / parallel branches are bare arrays with no authored edges) —
// so it is the one call site that could otherwise wire a note into the chain.

test('buildLinearEdges drops a note from the synthesized chain entirely', () => {
    const edges = buildLinearEdges([
        { id: 'a', type: 'set' },
        { id: 'note_1', type: 'note', text: 'why the next step is here' },
        { id: 'b', type: 'set' },
    ]);
    assert.deepStrictEqual(edges, [
        { from: '__loop_root__', to: 'a' },
        { from: 'a', to: 'b' },
    ]);
    assert.ok(!edges.some(e => e.from === 'note_1' || e.to === 'note_1'), 'the note got no edge in either direction');
});

test('a note as the FIRST body item does not become the sub-DAG root\'s target', () => {
    const edges = buildLinearEdges([
        { id: 'note_1', type: 'note', text: 'context' },
        { id: 'a', type: 'set' },
    ]);
    assert.deepStrictEqual(edges, [{ from: '__loop_root__', to: 'a' }]);
});

test('a loop body containing a note runs its real steps and never dispatches the note', async () => {
    const ran = [];
    const step = {
        id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100,
        body: [
            { id: 'note_1', type: 'note', text: 'explains this loop' },
            { id: 'after', type: 'notification', title: 'x' },
        ],
    };
    const state = { trigger: { output: { items: [1, 2] } }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
    const res = await execLoop(step, {}, state, 'live', failOnNoteDispatch(ran));
    assert.strictEqual(res.output.iterations, 2);
    assert.deepStrictEqual(ran, ['after', 'after']);
});
