/**
 * bind.js is a CommonJS facade over shared/mapping since the code moved
 * there. Its public surface must be exactly what it was, and the one thing
 * only the server adds (the AUTOMATION_DEBUG_BINDINGS log) must still fire.
 * The behaviour itself is pinned by shared/mapping/corpus.test.mjs, which
 * runs the golden corpus through this file too.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const bind = require('./bind');
const log = require('../telemetry/log');

test('exports the seven functions it had before the move, plus the three the v2 mapping added', () => {
    // isTextValue (a text field may hold a compose), bindingRunWarning (the
    // run warning a binding leaves, which execution.js persists) and
    // bindingWarningText (its English sentence).
    assert.deepStrictEqual(Object.keys(bind).sort(), [
        'bindingRunWarning', 'bindingWarningText', 'cloneLiteral', 'interpolateTemplate', 'isTextValue', 'resolveDeep', 'resolveInputs', 'resolveValue',
        'walkPath', 'walkRelativePath',
    ]);
    for (const fn of Object.values(bind)) assert.equal(typeof fn, 'function');
});

test('expr bindings run on the server engine', () => {
    assert.equal(bind.resolveValue({ kind: 'expr', value: 'upper(trigger.output.a)' }, { trigger: { output: { a: 'x' } } }), 'X');
});

test('AUTOMATION_DEBUG_BINDINGS logs an unresolved template path, and only then', (t) => {
    const warned = [];
    const original = log.warn;
    const env = process.env.AUTOMATION_DEBUG_BINDINGS;
    log.warn = (msg) => warned.push(msg);
    t.after(() => {
        log.warn = original;
        if (env === undefined) delete process.env.AUTOMATION_DEBUG_BINDINGS;
        else process.env.AUTOMATION_DEBUG_BINDINGS = env;
    });

    delete process.env.AUTOMATION_DEBUG_BINDINGS;
    bind.interpolateTemplate('{{trigger.output.missing}}', {});
    assert.deepStrictEqual(warned, []);

    process.env.AUTOMATION_DEBUG_BINDINGS = '1';
    bind.interpolateTemplate('{{trigger.output.missing}} {{trigger.output.a}}', { trigger: { output: { a: 1 } } });
    bind.resolveValue({ kind: 'template', value: '{{ steps.x.output }}' }, {});
    assert.deepStrictEqual(warned, [
        '[bind] template path "trigger.output.missing" resolved to undefined',
        '[bind] template path "steps.x.output" resolved to undefined',
    ]);
});

test('a ref or expr that gives no value leaves a run warning, as a template always did', () => {
    // The confirmed scenario: a ref to a field the upstream step did not
    // produce, and an expr that throws, used to resolve to undefined with
    // `_templateWarnings` left empty, so the tool got a missing argument and
    // the run never said why.
    const rs = { steps: { a: { output: { sum: 5 } }, x: { output: { list: ['p'] } } }, _templateWarnings: [] };
    const out = bind.resolveInputs({
        t: { kind: 'ref', path: 'steps.a.output.total' },
        e: { kind: 'expr', value: 'join(steps.x.output.list, ", "' },
        m: { kind: 'expr', value: 'steps.a.output.nope' },
        ok: { kind: 'ref', path: 'steps.a.output.sum' },
    }, rs);
    assert.deepStrictEqual(out, { t: undefined, e: undefined, m: undefined, ok: 5 }, 'the values themselves are unchanged');
    assert.equal(rs._templateWarnings.length, 3, JSON.stringify(rs._templateWarnings));
    // Structured like the run's outcome (runWarnings.js): a code the run view
    // words, the params it words it with, and the English as the fallback.
    assert.deepStrictEqual(rs._templateWarnings[0], {
        code: 'ref_missing', params: { input: 't', path: 'steps.a.output.total' }, text: 'input "t": steps.a.output.total resolved to nothing',
    });
    assert.equal(rs._templateWarnings[1].code, 'expr_error');
    assert.equal(rs._templateWarnings[1].params.expr, 'join(steps.x.output.list, ", "');
    assert.match(rs._templateWarnings[1].text, /^input "e": expression "join\(steps\.x\.output\.list, ", "" failed: /);
    assert.deepStrictEqual(rs._templateWarnings[2], {
        code: 'expr_missing', params: { input: 'm', expr: 'steps.a.output.nope' }, text: 'input "m": expression "steps.a.output.nope" resolved to nothing',
    });

    // Once per binding, however many items resolve it.
    bind.resolveInputs({ t: { kind: 'ref', path: 'steps.a.output.total' } }, rs);
    assert.equal(rs._templateWarnings.length, 3);

    // A snapshot of the inputs for run history is silent.
    const quiet = { _templateWarnings: [] };
    bind.resolveDeep({ t: { kind: 'ref', path: 'steps.a.output.total' } }, quiet, { silent: true });
    assert.deepStrictEqual(quiet._templateWarnings, []);
});

test('a pick leaves a run warning phrased with the label the author gave it', () => {
    // M1 left this open: the warning existed, but read as a path. A pick's
    // warning names its chip ("E-mail van klant"), and never the value.
    const rs = { steps: { s: { output: { rows: [{ e: 'a@b.nl' }, { e: 'c@d.nl' }] } } }, _templateWarnings: [] };
    const from = (...path) => ({ root: 'steps', id: 's', path: ['rows', ...path] });
    bind.resolveInputs({
        to: { kind: 'pick', v: 1, from: from('e'), take: 'one', as: 'native', label: 'E-mail van klant' },
        tel: { kind: 'pick', v: 1, from: from('tel'), take: 'one', as: 'native', label: 'Telefoon', required: true },
        n: { kind: 'pick', v: 1, from: from('e'), take: 'one', as: 'number' },
    }, rs);
    assert.deepStrictEqual(rs._templateWarnings.map(w => w.code), ['pick_many_for_one', 'pick_missing_required', 'pick_many_for_one', 'pick_parse_failed']);
    assert.deepStrictEqual(rs._templateWarnings[0].params, { input: 'to', label: 'E-mail van klant', path: 'steps.s.output.rows.e', count: 2 });
    assert.deepStrictEqual(rs._templateWarnings[3].params, { input: 'n', path: 'steps.s.output.rows.e', as: 'number' });
    assert.deepStrictEqual(rs._templateWarnings.map(w => w.text), [
        'input "to": "E-mail van klant" held 2 values; only the first was used',
        'input "tel": "Telefoon" was empty, and the step needs it',
        'input "n": steps.s.output.rows.e held 2 values; only the first was used',
        'input "n": steps.s.output.rows.e could not be read as a number',
    ]);
    assert.ok(!JSON.stringify(rs._templateWarnings).includes('a@b.nl'));
    assert.equal(bind.bindingWarningText({ code: 'holes_dropped', kind: 'pick', path: 'p', count: 2 }), 'p: 2 item(s) without this field were left out');
    assert.equal(bind.bindingWarningText({ code: 'each_outside_repeat', kind: 'compose', path: 'p', label: 'L' }), '"L" reads the current item, but this step does not repeat over that list');
});

test('isTextValue: a {{ }} string or a valid compose', () => {
    assert.equal(bind.isTextValue('x'), true);
    assert.equal(bind.isTextValue({ kind: 'compose', v: 1, parts: ['x'] }), true);
    assert.equal(bind.isTextValue({ kind: 'compose', parts: ['x'] }), false);
    assert.equal(bind.isTextValue(null), false);
});
