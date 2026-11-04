'use strict';

/**
 * A saved action test checked against the action it tests. Pure.
 *
 * Run: cd server && node --test appStudio/actionTests/testSpec.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normaliseTestSpec, readTestName, MAX_EXPECTATIONS } = require('./testSpec.mts');

const ACTION = { kind: 'sequence', steps: [
    { kind: 'ai_extract', schema: [{ name: 'customer' }], resultVar: 'ex' },
    { kind: 'set_variable', name: 'who', value: { kind: 'formula', expr: 'vars.ex.rows[0].customer' } },
    { kind: 'condition', expr: 'vars.who', then: [{ kind: 'ai_generate', prompt: 'x' }] },
] };
const EXPECT = [{ path: 'vars.who', op: 'is', value: 'ACME' }];

test('a valid test: trimmed name, scope, mock and expectations kept; unmocked AI steps hinted', () => {
    const out = normaliseTestSpec({ name: '  reads the customer ', scope: { vars: { a: 1 } }, mock: { 'steps[0]': { rows: [] } }, expect: EXPECT }, ACTION, 'act_1');
    assert.equal(out.name, 'reads the customer');
    assert.deepEqual(out.spec.scope.vars, { a: 1 });
    assert.deepEqual(out.spec.mock, { 'steps[0]': { rows: [] } });
    assert.deepEqual(out.spec.expect, EXPECT);
    assert.deepEqual(out.mockPaths, ['steps[0]']);
    assert.deepEqual(out.unmockedAiPaths, ['steps[2].then[0]']);
    assert.match(out.hints[0], /steps\[2\]\.then\[0\] \(ai_generate\) is not mocked/);
});

test('name: 1-80 characters, one line', () => {
    assert.match(readTestName('').error, /needs a name/);
    assert.match(readTestName('x'.repeat(81)).error, /at most 80/);
    assert.match(readTestName('a\nb').error, /one line/);
    assert.deepEqual(readTestName(' ok '), { name: 'ok' });
});

test('a missing action, a bad scope or mock are refused', () => {
    assert.match(normaliseTestSpec({ name: 't', expect: EXPECT }, null, 'act_gone').error, /no action "act_gone"/);
    assert.match(normaliseTestSpec({ name: 't', scope: 'x', expect: EXPECT }, ACTION, 'a').error, /scope must be an object/);
    const stale = normaliseTestSpec({ name: 't', mock: { 'steps[9]': 'x' }, expect: EXPECT }, ACTION, 'a');
    assert.match(stale.error, /not an AI or read step/);
    assert.match(stale._fixHint, /steps\[0\] \(ai_extract\)/);
});

test('expect: 1-50 items, a known path, a known op, a value unless unary, values at most 4 KB', () => {
    const check = (expect) => normaliseTestSpec({ name: 't', expect }, ACTION, 'a');
    assert.match(check([]).error, /1-50/);
    assert.match(check(Array.from({ length: MAX_EXPECTATIONS + 1 }, () => EXPECT[0])).error, /at most 50/);
    assert.match(check([{ path: 'steps[7].status', op: 'is', value: 'ok' }]).error, /expect\[0\]: .*starts with neither/);
    assert.match(check([{ path: 'steps[7].status', op: 'is', value: 'ok' }])._fixHint, /steps\[2\]\.then\[0\]/);
    assert.match(check([{ path: 'vars.who', op: 'matches', value: 'x' }]).error, /is not an op/);
    assert.match(check([{ path: 'vars.who', op: 'is' }]).error, /needs a value/);
    assert.deepEqual(check([{ path: 'vars.who', op: 'isEmpty', value: 'ignored' }]).spec.expect, [{ path: 'vars.who', op: 'isEmpty' }]);
    assert.match(check([{ path: 'vars.who', op: 'is', value: 'x'.repeat(5000) }]).error, /larger than 4 KB/);
    assert.match(check([{ path: 'x'.repeat(301), op: 'is', value: 1 }]).error, /at most 300/);
    assert.match(check(['nope']).error, /must be an object/);
});

test('the whole spec is capped at 128 KB', () => {
    const scope = { vars: { a: 'x'.repeat(60 * 1024) } };
    const mock = { 'steps[0]': { rows: [{ customer: 'y'.repeat(60 * 1024) }] } };
    const expect = Array.from({ length: 5 }, () => ({ path: 'vars.who', op: 'is', value: 'z'.repeat(3 * 1024) }));
    assert.match(normaliseTestSpec({ name: 't', scope, mock, expect }, ACTION, 'a').error, /larger than 128 KB/);
});
