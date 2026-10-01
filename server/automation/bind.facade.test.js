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
