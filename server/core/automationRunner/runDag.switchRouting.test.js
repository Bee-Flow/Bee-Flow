/**
 * Switch routing semantics — node-audit A3/A4/A5.
 *
 *   A3: routing normalises edge identity — a caseName-ONLY edge (legacy shape
 *       accepted by validate.js and drawn correctly by the canvas) must fire.
 *   A4: defaultBranch pointing at an UNWIRED case used to end the run
 *       silently; default routing now falls back to a wired `case:default`
 *       port, and a dead-end leaves a _templateWarnings breadcrumb.
 *   A5: consequence of A4 — the default port is reachable again when the
 *       defaultBranch redirect has nowhere to go.
 *
 * The real execSwitch runs (branch labels computed as in production).
 *
 * Run: node --test core/automationRunner/runDag.switchRouting.test.js
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

const { runDag, execSwitch } = require('../automationRunner');

function baseState(kind) {
    return { trigger: { output: { kind } }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

function makeDispatcher() {
    const ran = [];
    const dispatch = async (step, ctx, runState, mode) => {
        if (step.type === 'switch') return { ...(await execSwitch(step, ctx, runState, mode)), startedAt: new Date().toISOString() };
        ran.push(step.id);
        return { output: { ranId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null };
    };
    return { ran, dispatch };
}

const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });

const sw = (extra = {}) => ({
    id: 'sw', type: 'switch', expr: 'trigger.output.kind',
    cases: [{ name: 'vip', value: 'vip' }, { name: 'normal', value: 'normal' }],
    defaultBranch: null,
    ...extra,
});

// ── A3: caseName-only edges route ────────────────────────────────────────────

test('a caseName-only edge (no label) fires when its case matches', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [sw(), note('vipStep')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'vipStep', caseName: 'vip' }, // legacy shape: no label
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState('vip'), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['vipStep']);
});

test('an unlabelled edge out of a switch still never fires (deliberate)', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [sw(), note('plain')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'plain' }, // no label, no caseName
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    const state = baseState('vip');
    await runDag(def, {}, state, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, [], 'unrouted edges must not fire on a branch label');
});

// ── A4/A5: defaultBranch vs the default port ─────────────────────────────────

test('defaultBranch redirect to an UNWIRED case falls back to the wired default port', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [sw({ defaultBranch: 'normal' }), note('vipStep'), note('fallback')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'vipStep', label: 'case:vip', caseName: 'vip' },
            // 'normal' (the defaultBranch target) has NO edge…
            { from: 'sw', to: 'fallback', label: 'case:default', caseName: 'default' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState('unmatched-value'), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['fallback'], 'the wired default port is the recovery the user built');
});

test('no-match with neither defaultBranch case nor default port wired leaves a breadcrumb', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [sw({ defaultBranch: 'normal' }), note('vipStep')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'vipStep', label: 'case:vip', caseName: 'vip' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    const state = baseState('unmatched-value');
    await runDag(def, {}, state, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, []);
    assert.ok(state._templateWarnings.some(w => /sw routed to .* no edge carries/.test(w)),
        `expected dead-end breadcrumb, got: ${JSON.stringify(state._templateWarnings)}`);
});

test('a MATCHED declared case with no edge stays a deliberate dead end (no default rescue)', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [sw(), note('fallback')],
        edges: [
            { from: 'trg', to: 'sw' },
            // vip matches but is unwired; default port IS wired.
            { from: 'sw', to: 'fallback', label: 'case:default', caseName: 'default' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState('vip'), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, [], 'matched-but-unwired must not be silently rerouted');
});

test('defaultBranch redirect to a WIRED case routes there, not to the default port', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [sw({ defaultBranch: 'normal' }), note('normalStep'), note('fallback')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'normalStep', label: 'case:normal', caseName: 'normal' },
            { from: 'sw', to: 'fallback', label: 'case:default', caseName: 'default' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    await runDag(def, {}, baseState('unmatched-value'), 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['normalStep']);
});

test('execSwitch tags a defaultBranch redirect with viaDefault', async () => {
    const out = (await execSwitch(sw({ defaultBranch: 'normal' }), {}, baseState('zzz'))).output;
    assert.strictEqual(out.branch, 'case:normal');
    assert.strictEqual(out.viaDefault, true);
    const matchedOut = (await execSwitch(sw({ defaultBranch: 'normal' }), {}, baseState('vip'))).output;
    assert.strictEqual(matchedOut.branch, 'case:vip');
    assert.strictEqual(matchedOut.viaDefault, undefined);
});

// ── W4-11: a DISABLED brancher has to say which port it passes through ──────
//
// A disabled step returned `{disabled: true}` and nothing else, so nextLabel
// fell back to 'on_success' — which matches none of a then/else/case:* wiring.
// Disabling an If/Switch/Guard therefore ended the run right there: status
// success, everything downstream silently unexecuted, no warning anywhere.
// The chosen semantic is "a disabled node is not there": it passes through on
// its CONTINUE port ('then', or the configured default case for a switch).

const { _disabledPassThroughBranch } = require('../automationRunner');

/**
 * dispatchStep's disabled short-circuit. The port decision itself comes from
 * the runner's own helper, so this test moves with the production rule rather
 * than restating it.
 */
function dispatchWithDisabled(ran) {
    return async (step, ctx, runState, mode) => {
        if (step.disabled) {
            const branch = _disabledPassThroughBranch(step);
            return { output: { disabled: true, ...(branch ? { branch } : {}) }, skippedReason: 'disabled', startedAt: new Date().toISOString() };
        }
        if (step.type === 'switch') return { ...(await execSwitch(step, ctx, runState, mode)), startedAt: new Date().toISOString() };
        ran.push(step.id);
        return { output: { ranId: step.id }, startedAt: new Date().toISOString(), inputSnapshot: null };
    };
}

test('a disabled CONDITION passes the flow through its "then" port', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'cond', type: 'condition', disabled: true, expr: 'true' }, note('thenStep'), note('elseStep')],
        edges: [
            { from: 'trg', to: 'cond' },
            { from: 'cond', to: 'thenStep', label: 'then' },
            { from: 'cond', to: 'elseStep', label: 'else' },
        ],
    };
    const ran = [];
    const state = baseState('x');
    await runDag(def, {}, state, 'live', dispatchWithDisabled(ran), { recordSteps: false });
    assert.deepStrictEqual(ran, ['thenStep'], 'the rest of the flow still runs — and only ONE side of the If does');
});

test('a disabled SWITCH passes through its default port', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [sw({ disabled: true }), note('vipStep'), note('fallback')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'vipStep', label: 'case:vip' },
            { from: 'sw', to: 'fallback', label: 'case:default' },
        ],
    };
    const ran = [];
    await runDag(def, {}, baseState('vip'), 'live', dispatchWithDisabled(ran), { recordSteps: false });
    assert.deepStrictEqual(ran, ['fallback']);
});

test('a disabled brancher whose port is unwired leaves a breadcrumb instead of vanishing', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'cond', type: 'condition', disabled: true, expr: 'true' }, note('elseStep')],
        edges: [
            { from: 'trg', to: 'cond' },
            { from: 'cond', to: 'elseStep', label: 'else' }, // only the OTHER side is wired
        ],
    };
    const ran = [];
    const state = baseState('x');
    await runDag(def, {}, state, 'live', dispatchWithDisabled(ran), { recordSteps: false });
    assert.deepStrictEqual(ran, []);
    assert.ok(state._templateWarnings.some(w => /condition cond routed to "then".*no edge carries/.test(w)),
        `expected a dead-end breadcrumb for the disabled brancher, got: ${JSON.stringify(state._templateWarnings)}`);
});

// ── W4-12: the collection path needs the default rescue too ────────────────

test('a collection switch redirected into an UNWIRED case falls back to the default port', async () => {
    const rows = [{ id: 1, kind: 'vip' }, { id: 2, kind: 'other' }];
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            {
                id: 'sw', type: 'switch',
                arrayRef: 'steps.src.output.rows',
                expr: 'item.kind',
                cases: [{ name: 'vip', value: 'vip' }, { name: 'normal', value: 'normal' }],
                defaultBranch: 'normal', // …which has no outgoing edge
            },
            note('vipStep'), note('fallback'),
        ],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'vipStep', label: 'case:vip' },
            { from: 'sw', to: 'fallback', label: 'case:default' },
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    const state = baseState('x');
    state.steps.src = { output: { rows } };
    await runDag(def, {}, state, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual([...ran].sort(), ['fallback', 'vipStep'],
        'the matched case fires AND the redirected-but-unwired rows reach the default port');
});

// The breadcrumb has to be worth reading — these are the cases where "no edge
// carries that branch" is the DESIGNED ending, not a dead end.

test('a successful step whose only other edge is on_error gets no dead-end warning', async () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [note('work'), note('rescue')],
        edges: [
            { from: 'trg', to: 'work' },
            { from: 'work', to: 'rescue', label: 'on_error' }, // "if this fails, do that"
        ],
    };
    const { ran, dispatch } = makeDispatcher();
    const state = baseState('x');
    await runDag(def, {}, state, 'live', dispatch, { recordSteps: false });
    assert.deepStrictEqual(ran, ['work']);
    assert.deepStrictEqual(state._templateWarnings, [], 'an unused error edge is not a routing failure');
});

test('a dead-end breadcrumb is recorded once, not once per loop iteration', async () => {
    // The loop body shares the parent run state's warning array by reference.
    const state = baseState('unmatched-value');
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [sw({ defaultBranch: 'normal' }), note('vipStep')],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'vipStep', label: 'case:vip' },
        ],
    };
    const { dispatch } = makeDispatcher();
    await runDag(def, {}, state, 'live', dispatch, { recordSteps: false });
    await runDag(def, {}, state, 'live', dispatch, { recordSteps: false });
    assert.strictEqual(state._templateWarnings.length, 1, `got ${JSON.stringify(state._templateWarnings)}`);
});
