/**
 * Validatorregels voor de `return_to_app`-stap — P4, deel B.
 *
 * Drie soorten regel, met bewust verschillende hardheid:
 *
 *   VOCABULAIRE (tone / refresh / onError) blokkeert op ELKE trap. Deze waarden
 *   reizen als DATA naar een app-runtime in de browser, en daar is een waarde
 *   buiten de lijst geen halfgetypt veld maar een instructie die stil
 *   verdwijnt — precies wat deze stap moest voorkomen.
 *
 *   ONAF (nog geen scherm gekozen, nog niets ingevuld) is completeness: je bouwt
 *   een routine stap voor stap en de builder PUT bij elke toetsaanslag de hele
 *   definitie. Waarschuwen tijdens het bouwen, blokkeren bij activeren.
 *
 *   TERMINAAL (een rand erachter, een on_error-tak eruit, in een flowlet) hoort
 *   bij de gedeelde regel die validate/terminalSteps.test.js per plek bewaakt;
 *   hier staat wat een auteur er FEITELIJK van te zien krijgt.
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
// Elk hiervan reist als data naar de browser; een waarde buiten de lijst zou
// daar geruisloos wegvallen. Dus: blokkeren op ELKE trap, ook bij draft.

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

// ── de tweede plaatsingsregel: een lus of een tak is niet het einde ──────────
//
// De flowlet-regel hierboven kijkt alleen naar TOP-LEVEL stappen (graph.js
// toetst `isContractScope` per stap in `graph.steps`). Een stap in een
// loop-body of een parallelle tak loopt langs de GENESTELDE wandeling, en die
// leest precies één lijst: NESTED_FORBIDDEN_RULES. Stond `return_to_app` daar
// niet in, dan gebeurde dit:
//
//   LOOP-BODY      execFlow draait de body met recordSteps:false, dus er komt
//                  geen runregel; deriveRunOutcome vindt nooit `_appEffects` en
//                  de app krijgt niets. Het `break` in runDag beëindigt alleen
//                  die iteratie — de lus draait het volgende item en de run
//                  loopt door.
//   PARALLELLE TAK die regels worden wél opgenomen en erven parentStepId null,
//                  dus de app krijgt "we zijn klaar, ga hierheen" terwijl de
//                  andere takken en alles ná de parallel nog draaien.
//
// Vandaar: hard weigeren op ELKE trap, net als de flowlet-tweeling. De stapsoort
// is met P4 zelf geïntroduceerd, dus er is geen opgeslagen routine van vóór de
// regel die hierdoor onbewerkbaar wordt — daarom staat de code bewust NIET in
// COMPLETENESS_CODES.

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
