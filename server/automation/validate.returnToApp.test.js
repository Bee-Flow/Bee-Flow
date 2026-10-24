/**
 * Validator rules for the `return_to_app` step — P4, part B.
 *
 * Three kinds of rule, with deliberately different strictness:
 *
 *   VOCABULARY (tone / refresh / onError) blocks on EVERY level. These values
 *   travel as DATA to an app runtime in the browser, and there a value outside the
 *   list is not a half-typed field but an instruction that silently disappears —
 *   precisely what this step had to prevent.
 *
 *   INCOMPLETE (no screen chosen yet, nothing filled in yet) is completeness: you
 *   build an automation step by step and the builder PUTs the whole definition on
 *   every keystroke. Warn while building, block on activation.
 *
 *   TERMINAL (an edge behind it, an on_error branch out of it, inside a flowlet)
 *   belongs to the shared rule that validate/terminalSteps.test.js guards per place;
 *   here is what an author ACTUALLY sees of it.
 *
 * Run: cd server && node --test automation/validate.returnToApp.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');
const { VALID_STEP_TYPES, TERMINAL_STEP_TYPES } = require('./validate/constants');
const { COMPLETENESS_CODES } = require('./validate/completenessCodes');

const TRIGGER = { id: 'trg', kind: 'app_trigger' };

const OK = {
    type: 'return_to_app',
    label: 'Back to the app',
    navigateTo: { screenId: 'scr_orders', recordRef: '{{trigger.output.orderId}}' },
    toast: { message: 'Saved {{trigger.output.orderId}}', tone: 'success' },
    refresh: 'tableViews',
    onError: 'stay',
};

function def(step, extra = {}) {
    return {
        trigger: TRIGGER,
        steps: [{ id: 's1', ...step }],
        edges: [{ from: 'trg', to: 's1' }],
        ...extra,
    };
}
const recordsOf = (definition, stage) => {
    const res = validateDefinition(definition, stage ? { stage } : undefined);
    return [...(res.errors || []), ...(res.warnings || [])];
};
const codesOf = (definition, stage) => recordsOf(definition, stage).map(r => r.code);
const errorCodes = (definition, stage) => (validateDefinition(definition, stage ? { stage } : undefined).errors || []).map(e => e.code);

// ── vocabulary ──────────────────────────────────────────────────────────────

test('return_to_app is a known step type, and a fully filled one validates clean', () => {
    assert.ok(VALID_STEP_TYPES.has('return_to_app'));
    const codes = codesOf(def(OK));
    assert.ok(!codes.includes('step.unknown_type'), JSON.stringify(codes));
    assert.deepStrictEqual(codes.filter(c => c.startsWith('return_to_app.')), []);
});

test('every part is optional on its own — a step that only toasts is complete', () => {
    const codes = codesOf(def({ type: 'return_to_app', toast: { message: 'Done' } }));
    assert.deepStrictEqual(codes.filter(c => c.startsWith('return_to_app.')), [], JSON.stringify(codes));
});

// ── incomplete vs wrong ─────────────────────────────────────────────────────

test('a step that tells the app nothing is INCOMPLETE — amber while building, blocking at activate', () => {
    const bare = def({ type: 'return_to_app', onError: 'stay' });
    assert.ok(errorCodes(bare, 'activate').includes('return_to_app.empty'));
    assert.ok(!errorCodes(bare, 'draft').includes('return_to_app.empty'),
        'a freshly dropped node must keep autosaving');
    assert.ok(COMPLETENESS_CODES.has('return_to_app.empty'));
});

test('navigateTo without a screen is INCOMPLETE, not a shape error', () => {
    const half = def({ type: 'return_to_app', navigateTo: { recordRef: '{{trigger.output.id}}' } });
    assert.ok(errorCodes(half, 'activate').includes('return_to_app.screen_missing'));
    assert.ok(!errorCodes(half, 'draft').includes('return_to_app.screen_missing'));
    // …and it is NOT also reported as empty: the author has started on the
    // navigation, so telling them "this says nothing" would be wrong.
    assert.ok(!codesOf(half).includes('return_to_app.empty'));
});

test('navigateTo of the wrong SHAPE is an integrity error at every stage', () => {
    const bad = def({ type: 'return_to_app', navigateTo: 'scr_orders' });
    assert.ok(errorCodes(bad, 'draft').includes('return_to_app.navigateTo_shape'));
    assert.ok(!COMPLETENESS_CODES.has('return_to_app.navigateTo_shape'));
});

test('an empty toast message is refused — the app would show a blank bar', () => {
    assert.ok(errorCodes(def({ type: 'return_to_app', toast: { message: '   ' } }), 'draft')
        .includes('return_to_app.toast_empty'));
});

test('an oversized toast is refused rather than silently cut', () => {
    assert.ok(errorCodes(def({ type: 'return_to_app', toast: { message: 'x'.repeat(400) } }), 'draft')
        .includes('return_to_app.toast_too_long'));
});

// ── the three closed vocabularies ───────────────────────────────────────────
// Each of these travels as data to the browser; a value outside the list would
// silently drop there. So: block on EVERY level, including draft.

for (const [field, step, code] of [
    ['toast.tone', { type: 'return_to_app', toast: { message: 'Hi', tone: 'chartreuse' } }, 'return_to_app.tone_invalid'],
    ['refresh', { type: 'return_to_app', toast: { message: 'Hi' }, refresh: 'everything' }, 'return_to_app.refresh_invalid'],
    ['onError', { type: 'return_to_app', toast: { message: 'Hi' }, onError: 'explode' }, 'return_to_app.on_error_invalid'],
]) {
    test(`${field} outside its vocabulary blocks at draft stage too`, () => {
        assert.ok(errorCodes(def(step), 'draft').includes(code), `expected ${code}`);
        assert.ok(!COMPLETENESS_CODES.has(code), `${code} must NOT be completeness-listed`);
    });
}

// ── terminal ────────────────────────────────────────────────────────────────

test('return_to_app is on the shared terminal list', () => {
    assert.ok(TERMINAL_STEP_TYPES.has('return_to_app'));
});

test('an edge AFTER it is refused — incomplete while rewiring, blocking at activate', () => {
    const d = {
        trigger: TRIGGER,
        steps: [{ id: 's1', ...OK }, { id: 's2', type: 'notification', title: 'x', body: 'y', channels: ['notification'] }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
    assert.ok(errorCodes(d, 'activate').includes('edge.after_terminal'));
    assert.ok(!errorCodes(d, 'draft').includes('edge.after_terminal'),
        'converting a wired step to a return must not block the autosave that follows');
    assert.ok(codesOf(d, 'draft').includes('edge.after_terminal'), 'it still has to be SAID while building');
});

test('the stop_error half of the same rule is unchanged — still a warning at every stage', () => {
    const d = {
        trigger: TRIGGER,
        steps: [{ id: 's1', type: 'stop_error', message: 'nope' }, { id: 's2', type: 'notification', title: 'x', body: 'y', channels: ['notification'] }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
    assert.ok(codesOf(d, 'activate').includes('edge.after_stop_error'));
    assert.ok(!errorCodes(d, 'activate').includes('edge.after_stop_error'),
        'legacy definitions carrying this edge must keep activating');
});

test('an on_error branch OUT of it is refused — the branch could never be reached', () => {
    const d = {
        trigger: TRIGGER,
        steps: [{ id: 's1', ...OK }, { id: 's2', type: 'notification', title: 'x', body: 'y', channels: ['notification'] }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2', label: 'on_error' }],
    };
    assert.ok(errorCodes(d, 'draft').includes('edge.error_label_invalid'));
});

test('it is refused inside a flowlet — a contract scope returns to its CALLER, not to an app', () => {
    const d = {
        trigger: TRIGGER,
        steps: [],
        edges: [],
        layers: {
            enrich: {
                trigger: { id: 'lin', kind: 'layer_input', params: [] },
                steps: [{ id: 'l1', ...OK }, { id: 'l2', type: 'layer_output', fields: {} }],
                edges: [{ from: 'lin', to: 'l1' }],
            },
        },
    };
    assert.ok(errorCodes(d, 'draft').includes('layer.return_to_app_forbidden'), JSON.stringify(errorCodes(d, 'draft')));
});

// ── references ──────────────────────────────────────────────────────────────

test('both templates are checked like any other reference — a typo warns instead of rendering blank', () => {
    const d = def({
        type: 'return_to_app',
        toast: { message: 'Saved {{steps.nope.output.name}}' },
        navigateTo: { screenId: 'scr_x', recordRef: '{{steps.alsoNope.output.id}}' },
    });
    const refCodes = codesOf(d).filter(c => c.startsWith('ref.'));
    assert.ok(refCodes.length >= 1, `expected a ref warning, got ${JSON.stringify(codesOf(d))}`);
});

// ── the second placement rule: a loop or a branch is not the end ──────────
//
// The flowlet rule above only looks at TOP-LEVEL steps (graph.js checks
// `isContractScope` per step in `graph.steps`). A step in a loop body or a
// parallel branch walks the NESTED path instead, and that reads exactly one
// list: NESTED_FORBIDDEN_RULES. Had `return_to_app` not been in there, this
// would happen:
//
//   LOOP BODY      execFlow runs the body with recordSteps:false, so no run
//                  rule is written; deriveRunOutcome never finds `_appEffects`
//                  and the app gets nothing. The `break` in runDag only ends
//                  that iteration — the loop runs the next item and the run
//                  carries on.
//   PARALLEL BRANCH the rules ARE recorded and inherit parentStepId null,
//                  so the app gets "we are done, go here" while the other
//                  branches and everything after the parallel still run.
//
// Hence: refuse hard on EVERY level, just like the flowlet twin. The step kind
// was introduced with P4 itself, so there is no saved automation from before the
// rule that this would make uneditable — which is why the code deliberately is
// NOT in COMPLETENESS_CODES.

const NESTED_CODE = 'return_to_app.nested_forbidden';

function withLoopBody(body) {
    return {
        trigger: TRIGGER,
        steps: [
            { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 10, body },
            { id: 'nt', type: 'notification', title: 'x', body: 'y', channels: ['notification'] },
        ],
        edges: [{ from: 'trg', to: 'lp' }, { from: 'lp', to: 'nt' }],
    };
}

function withParallelBranch(branch) {
    return {
        trigger: TRIGGER,
        steps: [
            { id: 'pl', type: 'parallel', branches: [branch, [{ id: 'other', type: 'notification', title: 'x', body: 'y', channels: ['notification'] }]] },
            { id: 'nt', type: 'notification', title: 'x', body: 'y', channels: ['notification'] },
        ],
        edges: [{ from: 'trg', to: 'pl' }, { from: 'pl', to: 'nt' }],
    };
}

for (const [where, build] of [['a loop body', withLoopBody], ['a parallel branch', withParallelBranch]]) {
    test(`return_to_app inside ${where} is refused at draft AND at activate`, () => {
        const d = build([{ id: 'rta', ...OK }]);
        for (const stage of ['draft', 'activate']) {
            assert.ok(errorCodes(d, stage).includes(NESTED_CODE),
                `expected ${NESTED_CODE} as an ERROR at stage ${stage} — a ${where} is not the end of the run`);
        }
        assert.ok(!COMPLETENESS_CODES.has(NESTED_CODE),
            `${NESTED_CODE} must not be completeness-listed: the step type is new, so nothing stored predates the rule`);
    });

    test(`…while a stop_error in the same ${where} stays allowed — it THROWS, and a throw travels up`, () => {
        const d = build([{ id: 'st', type: 'stop_error', message: 'nope' }]);
        assert.ok(!errorCodes(d, 'activate').some(c => c.startsWith('stop_error.nested')),
            'stop_error needs no nesting rule: the sub-graph rethrows and the whole run fails');
    });
}

test('the counter-proof: the same return_to_app at TOP LEVEL is fine', () => {
    assert.ok(!errorCodes(def(OK), 'activate').includes(NESTED_CODE));
});
