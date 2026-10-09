/**
 * runDag wait scheduling — BFSF-371.
 *
 * The walker has ONE FIFO cursor and awaits `dispatchStep` inline, so whatever
 * sits at the head of the queue owns the runner until it returns. `wait` is the
 * one step type that is pure dead time — it produces nothing a sibling branch
 * could need, it just sleeps in-process for up to 24 hours. Put it at the head
 * of a fan-out and every other branch queues up behind the sleep, one node
 * deep:
 *
 *     split ─then→ a1 → a2 → a3
 *     split ─then→ w  → b2          FIFO: split, a1, w, a2, b2, a3
 *
 * Exactly one node of branch A got ahead of the sleep and the rest of the
 * workflow waited it out — which is what users report as "one Wait pauses the
 * whole automation".
 *
 * Fix: at the dequeue, prefer any runnable node that is NOT an enabled wait;
 * take a wait only when nothing else is runnable. Independent branches drain
 * first and the sleep happens once, at the end.
 *
 * The reorder is gated OFF for replaying walks (resume / partial runs) because
 * `stillSkipping` is temporal — see the last three tests, which are the whole
 * reason the gate exists.
 *
 * Run: node --test --test-force-exit core/automationRunner/runDag.waitScheduling.test.js
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

const { runDag, ApprovalRequiredError } = require('../automationRunner');

function baseState() {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

/**
 * Dispatcher that records execution order (same shape as runDag.fanIn.test.js)
 * and stands in for execWait on `wait` steps.
 *
 * The wait stub yields a full macrotask before resolving, so the ordering
 * assertions below are about SCHEDULING and not about a stub that happened to
 * resolve synchronously: if the walker had any way to interleave a sibling
 * across a wait, that yield is where it would show. `setImmediate` rather than
 * a timed `setTimeout` on purpose — a ref'd timer stretches the process past
 * the point `--test-force-exit` tears down the module-load-time pricing fetch,
 * which libuv reports as an assertion failure at exit (a flake, and nothing to
 * do with what is under test). And no keep-alive ticker: that is only needed
 * when driving the REAL execWait, whose own timers are unref'd
 * (execWait.test.js:38).
 */
function makeDispatcher(branches = {}) {
    const ran = [];
    const dispatch = async (step) => {
        ran.push(step.id);
        const base = { startedAt: new Date().toISOString(), inputSnapshot: null };
        if (step.type === 'wait') {
            await new Promise(r => setImmediate(r));
            return { ...base, output: { waitedSeconds: step.seconds ?? 1 } };
        }
        if (step.type === 'condition' || step.type === 'switch') {
            const branch = branches[step.id] || (step.type === 'condition' ? 'then' : 'case:default');
            return { ...base, output: { branch, value: branch === 'then' } };
        }
        return { ...base, output: { ranId: step.id } };
    };
    return { ran, dispatch };
}

const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });
const wait = (id, extra = {}) => ({ id, type: 'wait', seconds: 1, ...extra });
// A fan-out drawn as a condition whose 'then' port carries two edges: both are
// taken, which is the shape BFSF-371 was reported on.
const split = { id: 'split', type: 'condition', expr: 'true' };

// ── The report ───────────────────────────────────────────────────────────────

test('BFSF-371: a Wait in one branch no longer stalls the other branch', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [split, note('a1'), note('a2'), note('a3'), wait('w'), note('b2')],
        edges: [
            { from: 'trg', to: 'split' },
            { from: 'split', to: 'a1', label: 'then' },
            { from: 'split', to: 'w', label: 'then' },
            { from: 'a1', to: 'a2' },
            { from: 'a2', to: 'a3' },
            { from: 'w', to: 'b2' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });

    // The contract, stated as an ordering rather than a transcript: branch A
    // completes BEFORE the sleep starts. (Before the fix the order was
    // ['split','a1','w','a2','b2','a3'] — a2 and a3 sat behind the wait.)
    assert.ok(ran.indexOf('a3') < ran.indexOf('w'),
        `branch A must finish before the wait starts, got ${JSON.stringify(ran)}`);
    assert.ok(ran.indexOf('b2') > ran.indexOf('w'), 'b2 still runs after its own wait');
    assert.strictEqual(ran.length, 6, 'every step still runs exactly once');
});

test('a Wait that is not first in its branch is deferred just the same', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [split, note('a1'), note('a2'), note('b1'), wait('w'), note('b2')],
        edges: [
            { from: 'trg', to: 'split' },
            { from: 'split', to: 'b1', label: 'then' },
            { from: 'split', to: 'a1', label: 'then' },
            { from: 'b1', to: 'w' },
            { from: 'w', to: 'b2' },
            { from: 'a1', to: 'a2' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });

    assert.ok(ran.indexOf('a1') < ran.indexOf('w'), `a1 before the wait, got ${JSON.stringify(ran)}`);
    assert.ok(ran.indexOf('a2') < ran.indexOf('w'), `a2 before the wait, got ${JSON.stringify(ran)}`);
    assert.ok(ran.indexOf('b1') < ran.indexOf('w'), 'the wait still runs after its own predecessor');
});

test('a lone Wait still runs (nothing else is runnable)', async () => {
    // Guards the `findIndex === -1` fallback: when every queued node is an
    // enabled wait, take the head, exactly as the FIFO did.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [wait('w'), note('after')],
        edges: [{ from: 'trg', to: 'w' }, { from: 'w', to: 'after' }],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['w', 'after']);
});

test('two sibling Waits both run (the -1 fallback is not a dead end)', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [split, wait('w1'), wait('w2')],
        edges: [
            { from: 'trg', to: 'split' },
            { from: 'split', to: 'w1', label: 'then' },
            { from: 'split', to: 'w2', label: 'then' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['split', 'w1', 'w2'], 'sibling waits still serialise — the hint says so');
});

test('a DISABLED Wait keeps its FIFO position', async () => {
    // It never sleeps, so there is nothing to defer — and deferring it would
    // needlessly make it the last-recorded step of the run.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [split, wait('w', { disabled: true }), note('b2'), note('a1'), note('a2')],
        edges: [
            { from: 'trg', to: 'split' },
            { from: 'split', to: 'w', label: 'then' },
            { from: 'split', to: 'a1', label: 'then' },
            { from: 'w', to: 'b2' },
            { from: 'a1', to: 'a2' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['split', 'w', 'a1', 'b2', 'a2'], 'plain FIFO for a disabled wait');
});

// ── The fan-in gate is untouched ─────────────────────────────────────────────

test('fan-in: a join with a Wait on one arm still fires exactly once, after both arms', async () => {
    // runDag.fanIn.test.js's unequal-depth diamond, with the short arm made a
    // wait. Deferral moves the wait to the end, so the join's OTHER feeder
    // resolves first — the gate must still hold it until both edges land.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [wait('x'), note('y1'), note('y2'), note('j')],
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
    assert.strictEqual(ran.filter(id => id === 'j').length, 1, 'join must fire exactly once');
    assert.strictEqual(ran.indexOf('j'), ran.length - 1, 'join runs last');
    assert.ok(ran.indexOf('y2') < ran.indexOf('x'), 'the long arm drained before the sleep');
});

// ── lastOutput ───────────────────────────────────────────────────────────────

test('lastOutput is never the Wait, even when the Wait dispatched last', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [note('a1'), wait('w')],
        edges: [{ from: 'trg', to: 'a1' }, { from: 'trg', to: 'w' }],
    };
    const { ran, dispatch } = makeDispatcher();
    const result = await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.strictEqual(ran[ran.length - 1], 'w', 'the wait really is the last dispatch');
    assert.deepStrictEqual(result.lastOutput, { ranId: 'a1' },
        '{ waitedSeconds } is bookkeeping, not an automation result');
});

// ── Why the reorder is gated off for replaying walks ─────────────────────────
//
// `stillSkipping` is a purely TEMPORAL flag: during a replay it decides, per
// dequeue, whether a step is re-played from runState or dispatched FOR REAL.
// Reordering the queue therefore reorders that decision — and the run that
// paused BEFORE this change is sitting in a runState recorded under the old
// FIFO order. That mismatch is the whole hazard, and `deferWaits` closes it.

const approvalDef = () => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [split, wait('w'), note('b2'), { id: 'ap', type: 'approval', prompt: 'ok?' }, note('a2')],
    edges: [
        { from: 'trg', to: 'split' },
        { from: 'split', to: 'w', label: 'then' },
        { from: 'split', to: 'ap', label: 'then' },
        { from: 'w', to: 'b2' },
        { from: 'ap', to: 'a2' },
    ],
});

test('resume of a run paused under the OLD order does not re-sleep the Wait', async () => {
    // The transitional case, verbatim: a run that paused on an approval before
    // this deploy. Under the old FIFO the wait sat ahead of the approval, so it
    // SLEPT and was recorded; the resume then replays it.
    //
    // Were the reorder active here, the resume would defer `w` past `ap`,
    // `stillSkipping` would already be false by the time `w` is dequeued, and
    // the walker would dispatch it LIVE — a second sleep of up to 24 hours,
    // with a human sitting in front of the approval they just granted.
    const state = baseState();
    state.steps = {
        split: { output: { branch: 'then', value: true }, status: 'success' },
        w: { output: { waitedSeconds: 1 }, status: 'success' },     // it already slept
        ap: { output: { approved: true }, status: 'success' },      // the decision resumeFromStep writes
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(approvalDef(), {}, state, 'live', dispatch, { recordSteps: false, skipUntilStepId: 'ap' });

    assert.strictEqual(ran.filter(id => id === 'w').length, 0,
        'the recorded wait must be REPLAYED on resume, never slept again');
    assert.ok(ran.includes('a2') && ran.includes('b2'), 'everything after the gate still runs live');
});

test('a Wait upstream of an approval sleeps exactly once across both legs', async () => {
    // trg → w → ap → after. The wait is genuinely reached before the pause, so
    // leg 1 sleeps it and leg 2 replays it: one sleep in total.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [wait('w'), { id: 'ap', type: 'approval', prompt: 'ok?' }, note('after')],
        edges: [{ from: 'trg', to: 'w' }, { from: 'w', to: 'ap' }, { from: 'ap', to: 'after' }],
    };
    const { ran, dispatch } = makeDispatcher();
    let pending = true;
    const gated = async (step, ...rest) => {
        if (step.id === 'ap' && pending) throw new ApprovalRequiredError('ap', 'ok?');
        return dispatch(step, ...rest);
    };

    const state = baseState();
    await assert.rejects(
        () => runDag(def, {}, state, 'live', gated, { recordSteps: false }),
        /Approval required/,
    );
    assert.deepStrictEqual(ran, ['w'], 'leg 1 slept the wait, then paused');

    pending = false;
    state.steps.ap = { output: { approved: true }, status: 'success' };
    await runDag(def, {}, state, 'live', gated, { recordSteps: false, skipUntilStepId: 'ap' });

    assert.strictEqual(ran.filter(id => id === 'w').length, 1, 'the wait slept exactly ONCE across both legs');
    assert.deepStrictEqual(ran, ['w', 'after']);
});

test('deferral means a sibling Wait has not slept yet when an approval pauses the run', async () => {
    // The honest consequence of the reorder, pinned so nobody has to rediscover
    // it: with the wait taken LAST, a run that pauses on an approval in another
    // branch pauses before that wait ever starts. The resume replays it as a
    // no-op (no recorded output, and `mayFillLive` is false outside a partial
    // run), so branch B continues immediately instead of sleeping.
    //
    // This is the pre-existing resume contract for ANY sibling that had not run
    // at pause time, not something waits alone are subject to — the reorder only
    // changes WHICH node ends up in that position. Deliberate, and strictly
    // better than the alternative it replaces (blocking every other branch for
    // up to 24 hours before the approval is even raised).
    const state = baseState();
    const { ran, dispatch } = makeDispatcher();
    let pending = true;
    const gated = async (step, ...rest) => {
        if (step.id === 'ap' && pending) throw new ApprovalRequiredError('ap', 'ok?');
        return dispatch(step, ...rest);
    };

    await assert.rejects(
        () => runDag(approvalDef(), {}, state, 'live', gated, { recordSteps: false }),
        /Approval required/,
    );
    assert.deepStrictEqual(ran, ['split'], 'the wait had not started when the approval paused the run');

    pending = false;
    state.steps.ap = { output: { approved: true }, status: 'success' };
    await runDag(approvalDef(), {}, state, 'live', gated, { recordSteps: false, skipUntilStepId: 'ap' });

    assert.strictEqual(ran.filter(id => id === 'w').length, 0, 'the un-run wait is replayed, not dispatched');
    assert.ok(ran.includes('b2'), 'branch B continues past it');
    assert.ok(ran.includes('a2'), 'branch A continues past the approval');
});

// ── A flowlet's Return goes last (2026-10-09) ────────────────────────────────
// The AI builder saved "add after the flowlet input" as a branch BESIDE the
// Return (trg → out, trg → web → fmt). FIFO ran the Return second, before the
// work it returns, and the flowlet handed its caller an empty record.

const ret = { id: 'out', type: 'layer_output', fields: {} };

test('a Return wired beside the work runs after all of it', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'layer_input' },
        steps: [ret, note('web'), note('fmt')],
        edges: [{ from: 'trg', to: 'out' }, { from: 'trg', to: 'web' }, { from: 'web', to: 'fmt' }],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['web', 'fmt', 'out']);
});

test('the Return goes after a deferred Wait too', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'layer_input' },
        steps: [ret, wait('w'), note('after')],
        edges: [{ from: 'trg', to: 'out' }, { from: 'trg', to: 'w' }, { from: 'w', to: 'after' }],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState(), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['w', 'after', 'out']);
});
