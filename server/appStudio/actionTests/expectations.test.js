'use strict';

/**
 * Expectations of a saved action test, read against an outcome view. Pure.
 *
 * Run: cd server && node --test appStudio/actionTests/expectations.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readPath, evaluateTest, pathProblem, expectationOps, isUnaryOp } = require('./expectations.mts');

function view(over = {}) {
    const steps = new Map([
        ['steps[0]', { path: 'steps[0]', kind: 'ai_extract', ordinal: 0, status: 'ok', ms: 2, count: 1, mocked: true, result: { rows: [{ customer: 'ACME' }], count: 1 } }],
        ['steps[1]', { path: 'steps[1]', kind: 'ai_generate', ordinal: 1, status: 'ok', ms: 1, count: 1, prompt: 'Summarise T-1', result: { text: 'ok' } }],
        ['steps[10]', { path: 'steps[10]', kind: 'toast', ordinal: 10, status: 'not_run', ms: 0, count: 0 }],
        ['steps[2]', { path: 'steps[2]', kind: 'loop', ordinal: 2, status: 'ok', ms: 0, count: 1, result: { iterations: 3 } }],
        ['steps[2].steps[0]', { path: 'steps[2].steps[0]', kind: 'kb_query', ordinal: 3, status: 'error', ms: 0, count: 3, error: 'boom' }],
    ]);
    return { ok: true, stopped: null, failed: null, vars: { who: 'ACME', n: 3, list: [1, 2] }, result: { text: 'ok' }, steps, ...over };
}

test('readPath: run roots, vars and result with the shared path grammar', () => {
    const v = view();
    assert.equal(readPath(v, 'ok'), true);
    assert.equal(readPath(v, 'stopped'), null);
    assert.equal(readPath(v, 'vars.who'), 'ACME');
    assert.deepEqual(readPath(v, 'vars'), v.vars);
    assert.equal(readPath(v, 'vars.list[1]'), 2);
    assert.equal(readPath(v, 'result.text'), 'ok');
    assert.equal(readPath(v, 'vars.nope'), undefined);
});

test('readPath: a step path reads its outcome; the longest known path wins; steps[1] is not steps[10]', () => {
    const v = view();
    assert.equal(readPath(v, 'steps[0].result.rows[0].customer'), 'ACME');
    assert.equal(readPath(v, 'steps[0].mocked'), true);
    assert.equal(readPath(v, 'steps[1].mocked'), false);
    assert.equal(readPath(v, 'steps[1].prompt'), 'Summarise T-1');
    assert.equal(readPath(v, 'steps[10].status'), 'not_run');
    assert.equal(readPath(v, 'steps[2].steps[0].count'), 3);
    assert.equal(readPath(v, 'steps[2].steps[0].error'), 'boom');
    assert.equal(readPath(v, 'steps[2].result.iterations'), 3);
    assert.equal(readPath(v, 'steps[2]').status, 'ok');
    assert.equal(readPath(v, 'steps[0].attempts'), 1, 'a step that ran once made one attempt');
    assert.equal(readPath(v, 'steps[0].handled'), false);
    assert.equal(readPath(v, 'steps[10].attempts'), 0, 'a step that did not run made none');
});

test('readPath: .attempts and .handled of a retried, handled step', () => {
    const steps = new Map([['steps[0]', { path: 'steps[0]', kind: 'ai_generate', ordinal: 0, status: 'error', ms: 1, count: 1, attempts: 3, handled: true, error: 'down' }]]);
    const v = { ok: true, stopped: null, failed: null, vars: {}, result: null, steps };
    assert.equal(readPath(v, 'steps[0].attempts'), 3);
    assert.equal(readPath(v, 'steps[0].handled'), true);
});

test('pathProblem: parseable path, known root, an outcome field after a step path', () => {
    const known = ['steps[0]', 'steps[1]'];
    assert.equal(pathProblem('vars.x', known), null);
    assert.equal(pathProblem('ok', known), null);
    assert.equal(pathProblem('steps[0].result.rows', known), null);
    assert.equal(pathProblem('steps[1]', known), null);
    assert.match(pathProblem('steps[0].bogus', known), /after a step path read one of/);
    assert.match(pathProblem('steps[5].status', known), /starts with neither/);
    assert.match(pathProblem('form.x', known), /starts with neither/);
    assert.match(pathProblem('vars..x', known), /is not a path/);
    assert.match(pathProblem('', known), /required/);
});

test('every op of the rule vocabulary is accepted; unary ops take no value', () => {
    assert.deepEqual(expectationOps().sort(), ['contains', 'endsWith', 'eq', 'gt', 'gte', 'is', 'isEmpty', 'isNot', 'isNotEmpty', 'lt', 'lte', 'neq', 'notContains', 'startsWith'].sort());
    assert.equal(isUnaryOp('isEmpty'), true);
    assert.equal(isUnaryOp('is'), false);
});

test('evaluateTest: per-expectation pass/fail with actual; ops compare like rule rows', () => {
    const v = view();
    const { pass, results } = evaluateTest(v, [
        { path: 'vars.who', op: 'is', value: 'ACME' },
        { path: 'vars.n', op: 'gt', value: 2 },
        { path: 'steps[1].prompt', op: 'contains', value: 'T-1' },
        { path: 'vars.list', op: 'isNotEmpty' },
        { path: 'steps[10].status', op: 'is', value: 'not_run' },
        { path: 'vars.who', op: 'startsWith', value: 'X' },
    ]);
    assert.equal(pass, false);
    assert.deepEqual(results.map((r) => r.pass), [true, true, true, true, true, false]);
    assert.deepEqual(results[5], { path: 'vars.who', op: 'startsWith', expected: 'X', actual: 'ACME', pass: false });
    assert.equal('expected' in results[3], false, 'a unary op shows no expected value');
});

test('evaluateTest: a missing value reads as null', () => {
    const { results } = evaluateTest(view(), [{ path: 'vars.missing', op: 'is', value: 'ACME' }]);
    assert.equal(results[0].actual, null);
    assert.equal(results[0].pass, false);
});

test('evaluateTest: a run that stopped on an error fails implicitly, unless an expectation reads ok or stopped', () => {
    const stopped = view({ ok: false, stopped: 'steps[1] failed', failed: { path: 'steps[1]', kind: 'ai_generate', error: 'The prompt is empty' } });
    const implicit = evaluateTest(stopped, [{ path: 'vars.who', op: 'is', value: 'ACME' }]);
    assert.equal(implicit.pass, false);
    assert.equal(implicit.results[1].reason, 'the run stopped: steps[1] failed: The prompt is empty');
    const explicit = evaluateTest(stopped, [{ path: 'ok', op: 'is', value: false }, { path: 'stopped', op: 'contains', value: 'steps[1]' }]);
    assert.equal(explicit.pass, true);
    assert.equal(explicit.results.length, 2);
});

test('evaluateTest: the trim function shapes actual', () => {
    const { results } = evaluateTest(view(), [{ path: 'vars.list', op: 'is', value: [] }], () => '[trimmed]');
    assert.equal(results[0].actual, '[trimmed]');
});
