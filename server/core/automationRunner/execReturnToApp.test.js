/**
 * `return_to_app` aan de runnerkant — het effectenobject dat de app krijgt.
 *
 * Twee dingen die deze stap moet waarmaken, en die allebei stil kunnen falen:
 *
 *   1. HET OBJECT WORDT UIT EEN ALLOW-LIST GEBOUWD. Niet door sleutels van de
 *      stap te verwijderen — dan reist een veld dat volgend jaar aan een stap
 *      wordt toegevoegd vanzelf mee de browser in.
 *   2. WAT NIET MEEGAAT, WORDT GEZEGD. Een effect dat hier wegvalt, verdwijnt
 *      anders precies zoals de instructie die deze stap moest redden. Dus:
 *      `output._ignored` (de runregel die de runweergave toont) én een regel op
 *      `_templateWarnings`.
 *
 * Run: cd server && node --test core/automationRunner/execReturnToApp.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { execReturnToApp } = require('./execControl');
const { TERMINAL_STEP_TYPES } = require('../../automation/validate/constants');

const stateWith = (steps = {}, trigger = {}) => ({
    trigger: { output: trigger },
    steps,
    vars: {},
    secrets: {},
    loop: {},
    _templateWarnings: [],
});

test('it is on the shared terminal list — the runner ends its walk here', () => {
    assert.ok(TERMINAL_STEP_TYPES.has('return_to_app'));
});

test('a filled step becomes one effects object, with both templates resolved', async () => {
    const state = stateWith({ save: { output: { id: 'ord_42', name: 'Acme' } } });
    const { output } = await execReturnToApp({
        id: 'r1',
        type: 'return_to_app',
        navigateTo: { screenId: 'scr_orders', recordRef: '{{steps.save.output.id}}' },
        toast: { message: 'Saved {{steps.save.output.name}}', tone: 'success' },
        refresh: 'tableViews',
        onError: 'errorScreen',
    }, {}, state);

    assert.deepStrictEqual(output._appEffects, {
        // `params.id` — de naam die elk App Studio-detailscherm leest
        // (`screen.params.id`).
        navigateTo: { screenId: 'scr_orders', params: { id: 'ord_42' } },
        toast: { message: 'Saved Acme', tone: 'success' },
        refresh: 'tableViews',
        onError: 'errorScreen',
    });
    assert.strictEqual(output._ignored, undefined, 'nothing was dropped');
});

test('the effects object is built from an allow-list — an unrelated step field never reaches the browser', async () => {
    const { output } = await execReturnToApp({
        id: 'r1',
        type: 'return_to_app',
        toast: { message: 'Done' },
        // Alles hieronder hoort NIET in het effectenobject: interne velden, een
        // veld dat een latere stage zou kunnen toevoegen, en iets wat er
        // gewoon niet in thuishoort.
        label: 'Back to the app',
        position: { x: 1, y: 2 },
        secretSauce: 'nope',
    }, {}, stateWith());
    assert.deepStrictEqual(Object.keys(output._appEffects).sort(), ['onError', 'toast']);
});

test('onError narrows to "stay" when it is absent — the visitor stays where they are', async () => {
    const { output } = await execReturnToApp(
        { id: 'r1', type: 'return_to_app', toast: { message: 'Done' } }, {}, stateWith(),
    );
    assert.strictEqual(output._appEffects.onError, 'stay');
});

test('a value outside the vocabulary is dropped, narrowed AND recorded — never silently applied', async () => {
    const state = stateWith();
    const { output } = await execReturnToApp({
        id: 'r1',
        type: 'return_to_app',
        toast: { message: 'Done', tone: 'chartreuse' },
        refresh: 'everything',
        onError: 'explode',
    }, {}, state);

    assert.strictEqual(output._appEffects.toast.tone, 'info', 'an unknown tone falls back to info');
    assert.strictEqual(output._appEffects.refresh, undefined, 'an unknown refresh is not forwarded');
    assert.strictEqual(output._appEffects.onError, 'stay', 'an unknown fallback narrows to staying put');

    const fields = output._ignored.map(i => i.field).sort();
    assert.deepStrictEqual(fields, ['onError', 'refresh', 'toast.tone']);
    for (const entry of output._ignored) {
        assert.ok(entry.reason && entry.reason.length > 10, `${entry.field}: give a real reason`);
    }
    // …en dezelfde drie staan in het runlog-kanaal, zodat ze ook zichtbaar zijn
    // voor wie niet de stapuitvoer opent.
    assert.strictEqual(state._templateWarnings.filter(w => w.startsWith('return_to_app r1:')).length, 3,
        JSON.stringify(state._templateWarnings));
});

test('a navigation with no screen is dropped and said out loud — the app has nowhere to go', async () => {
    const state = stateWith();
    const { output } = await execReturnToApp({
        id: 'r1', type: 'return_to_app', navigateTo: { recordRef: '{{trigger.output.id}}' }, toast: { message: 'Done' },
    }, {}, state);
    assert.strictEqual(output._appEffects.navigateTo, undefined);
    assert.deepStrictEqual(output._ignored.map(i => i.field), ['navigateTo']);
});

test('a recordRef that resolves to nothing still navigates — but without pretending it found a record', async () => {
    const state = stateWith();
    const { output } = await execReturnToApp({
        id: 'r1', type: 'return_to_app', navigateTo: { screenId: 'scr_x', recordRef: '{{steps.gone.output.id}}' },
    }, {}, state);
    assert.deepStrictEqual(output._appEffects.navigateTo, { screenId: 'scr_x' });
    assert.deepStrictEqual(output._ignored.map(i => i.field), ['navigateTo.recordRef']);
});

test('a toast whose template resolves to nothing is dropped rather than shown blank', async () => {
    const state = stateWith();
    const { output } = await execReturnToApp({
        id: 'r1', type: 'return_to_app', toast: { message: '{{steps.gone.output.name}}' }, refresh: 'resetForm',
    }, {}, state);
    assert.strictEqual(output._appEffects.toast, undefined);
    assert.strictEqual(output._appEffects.refresh, 'resetForm', 'the effects that DID work are unaffected');
    assert.ok(output._ignored.some(i => i.field === 'toast'));
});

test('a long toast is cut to the same ceiling the validator enforces', async () => {
    const { RETURN_TO_APP_MAX_TOAST_CHARS } = require('../../automation/validate/constants');
    const state = stateWith({ s: { output: { text: 'x'.repeat(1000) } } });
    const { output } = await execReturnToApp({
        id: 'r1', type: 'return_to_app', toast: { message: '{{steps.s.output.text}}' },
    }, {}, state);
    assert.strictEqual(output._appEffects.toast.message.length, RETURN_TO_APP_MAX_TOAST_CHARS);
});

test('it never throws — unlike stop_error, this step ends the run SUCCESSFULLY', async () => {
    // Als deze stap zou gooien, zou elke app die netjes terugkeert een rode run
    // opleveren. De hele reden dat runDag een terminaalbegrip nodig had.
    const { output } = await execReturnToApp({ id: 'r1', type: 'return_to_app' }, {}, stateWith());
    assert.deepStrictEqual(output._appEffects, { onError: 'stay' });
});
