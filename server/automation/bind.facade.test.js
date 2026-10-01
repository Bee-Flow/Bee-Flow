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

test('exports the same seven functions as before the move', () => {
    assert.deepStrictEqual(Object.keys(bind).sort(), [
        'cloneLiteral', 'interpolateTemplate', 'resolveDeep', 'resolveInputs', 'resolveValue', 'walkPath', 'walkRelativePath',
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
    assert.equal(rs._templateWarnings[0], 'input "t": steps.a.output.total resolved to nothing');
    assert.match(rs._templateWarnings[1], /^input "e": expression "join\(steps\.x\.output\.list, ", "" failed: /);
    assert.equal(rs._templateWarnings[2], 'input "m": expression "steps.a.output.nope" resolved to nothing');

    // Once per binding, however many items resolve it.
    bind.resolveInputs({ t: { kind: 'ref', path: 'steps.a.output.total' } }, rs);
    assert.equal(rs._templateWarnings.length, 3);

    // A snapshot of the inputs for run history is silent.
    const quiet = { _templateWarnings: [] };
    bind.resolveDeep({ t: { kind: 'ref', path: 'steps.a.output.total' } }, quiet, { silent: true });
    assert.deepStrictEqual(quiet._templateWarnings, []);
});
