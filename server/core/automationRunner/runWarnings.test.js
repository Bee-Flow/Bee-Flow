/**
 * recordedRunWarnings: what the run row keeps of runState._templateWarnings.
 *
 * REGRESSION (M1 left open, confirmed bug "Missing ref/expr values and expr
 * errors are silent"): bind.js put a sentence on _templateWarnings for every
 * ref, expr and pick that gave no value, but no code read that array, so the
 * warning existed only in memory and the run view never showed it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { recordedRunWarnings, pushRunWarning, runWarning, MAX_RUN_WARNINGS, MAX_WARNING_CHARS } = require('./runWarnings');

// The run row keeps the shape the run's outcome has, so the run view can word
// each warning in the viewer's language by code (mapping.run_warning.<code>).
test('a bare template path is wrapped as template_missing; structured warnings keep their code', () => {
    const pick = runWarning('pick_missing', { input: 'to', label: 'E-mail van klant', path: 'steps.s.output.e' }, 'input "to": "E-mail van klant" was empty');
    assert.deepStrictEqual(recordedRunWarnings([
        'steps.s1.output.total',
        pick,
        'trigger.output["Due date"]',
    ]), [
        { code: 'template_missing', params: { path: 'steps.s1.output.total' }, text: '{{steps.s1.output.total}} resolved to nothing' },
        { code: 'pick_missing', params: { input: 'to', label: 'E-mail van klant', path: 'steps.s.output.e' }, text: 'input "to": "E-mail van klant" was empty' },
        { code: 'template_missing', params: { path: 'trigger.output["Due date"]' }, text: '{{trigger.output["Due date"]}} resolved to nothing' },
    ]);
});

test('params come from the allow-list only, and never hold anything but text and numbers', () => {
    const w = runWarning('pick_missing', { input: 'to', value: 'ada@example.org', row: { e: 'x' }, count: 2, as: undefined, label: null }, 't');
    assert.deepStrictEqual(w, { code: 'pick_missing', params: { input: 'to', count: 2 }, text: 't' });
    // A structured entry pushed with extra params is cleaned the same way when it is recorded.
    const [rec] = recordedRunWarnings([{ code: 'ref_missing', params: { path: 'a.b', secret: 's' }, text: 'a.b resolved to nothing' }]);
    assert.deepStrictEqual(rec.params, { path: 'a.b' });
});

test('each warning once, in the order it happened; empties dropped', () => {
    const a = runWarning('branch_no_edge', { step: 'sw', branch: 'x' }, 'sw routed to "x"');
    assert.deepStrictEqual(
        recordedRunWarnings(['a.b', a, 'a.b', '', null, { ...a }, 42, { text: 'no code' }]).map(w => w.code),
        ['template_missing', 'branch_no_edge'],
    );
});

test('pushRunWarning adds a warning once per code and params', () => {
    const rs = { _templateWarnings: ['legacy.path'] };
    pushRunWarning(rs, runWarning('guard_unwired', { step: 'g' }, 'guard g'));
    pushRunWarning(rs, runWarning('guard_unwired', { step: 'g' }, 'guard g'));
    pushRunWarning(rs, runWarning('guard_unwired', { step: 'h' }, 'guard h'));
    assert.equal(rs._templateWarnings.length, 3);
    pushRunWarning({}, runWarning('guard_unwired', { step: 'g' }, 'guard g')); // no list: tolerated
});

test('nothing collected is an empty list', () => {
    assert.deepStrictEqual(recordedRunWarnings(undefined), []);
    assert.deepStrictEqual(recordedRunWarnings([]), []);
});

test('capped in count and in length', () => {
    const many = Array.from({ length: MAX_RUN_WARNINGS + 7 }, (_, i) => `steps.s${i}.output.x`);
    const out = recordedRunWarnings(many);
    assert.equal(out.length, MAX_RUN_WARNINGS + 1);
    assert.deepStrictEqual(out[out.length - 1], { code: 'more', params: { count: 7 }, text: '…and 7 more warning(s)' });
    const long = recordedRunWarnings([runWarning('ref_missing', { path: 'p'.repeat(1000) }, `x ${'y'.repeat(1000)}`)])[0];
    assert.equal(long.text.length, MAX_WARNING_CHARS);
    assert.ok(long.text.endsWith('…'));
    assert.equal(long.params.path.length, MAX_WARNING_CHARS);
});
