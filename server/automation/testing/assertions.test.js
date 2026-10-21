'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validateAssertions, evaluateAssertions, deepEqual } = require('./assertions');

const run = (target, a) => evaluateAssertions(target, [{ id: 'a', path: '', ...a }])[0];

test('equals: JSON semantics, key order does not matter', () => {
    assert.strictEqual(run({ a: 1, b: [1, { c: 2 }] }, { op: 'equals', value: { b: [1, { c: 2 }], a: 1 } }).ok, true);
    const bad = run({ a: 1 }, { op: 'equals', value: { a: 2 } });
    assert.deepStrictEqual(bad, { id: 'a', ok: false, code: 'not_equal', params: { path: '', expected: '{"a":2}', actual: '{"a":1}' } });
    assert.strictEqual(run([1, 2], { op: 'equals', value: [2, 1] }).ok, false, 'array order matters');
    assert.strictEqual(run(1, { op: 'equals', value: '1' }).ok, false);
    assert.strictEqual(run(null, { op: 'equals', value: null }).ok, true, 'null is a value, not a missing path');
});

test('not_equals', () => {
    assert.strictEqual(run(5, { op: 'not_equals', value: 6 }).ok, true);
    assert.strictEqual(run(5, { op: 'not_equals', value: 5 }).code, 'equal');
});

test('contains: substring, array element, array element superset, object subset', () => {
    assert.strictEqual(run('hello world', { op: 'contains', value: 'lo wo' }).ok, true);
    assert.strictEqual(run('hello', { op: 'contains', value: 'xyz' }).code, 'not_contained');
    assert.strictEqual(run('hello', { op: 'contains', value: 5 }).code, 'not_contained');
    assert.strictEqual(run([1, 'a', { k: 1 }], { op: 'contains', value: 'a' }).ok, true);
    assert.strictEqual(run([{ k: 1, extra: true }], { op: 'contains', value: { k: 1 } }).ok, true);
    assert.strictEqual(run([{ k: 2 }], { op: 'contains', value: { k: 1 } }).ok, false);
    assert.strictEqual(run({ a: 1, b: { c: 2 } }, { op: 'contains', value: { b: { c: 2 } } }).ok, true);
    assert.strictEqual(run({ a: 1 }, { op: 'contains', value: { a: 2 } }).ok, false);
    assert.strictEqual(run(42, { op: 'contains', value: 4 }).code, 'wrong_type');
});

test('has_key', () => {
    assert.strictEqual(run({ a: undefined, b: 1 }, { op: 'has_key', value: 'b' }).ok, true);
    assert.strictEqual(run({ a: 1 }, { op: 'has_key', value: 'z' }).code, 'key_missing');
    assert.strictEqual(run({ a: 1 }, { op: 'has_key', value: 'toString' }).code, 'key_missing', 'inherited keys do not count');
    assert.strictEqual(run([1], { op: 'has_key', value: '0' }).code, 'wrong_type');
});

test('type_is tells array and null apart', () => {
    assert.strictEqual(run([], { op: 'type_is', value: 'array' }).ok, true);
    assert.strictEqual(run([], { op: 'type_is', value: 'object' }).code, 'wrong_type');
    assert.strictEqual(run(null, { op: 'type_is', value: 'null' }).ok, true);
    assert.strictEqual(run(null, { op: 'type_is', value: 'object' }).ok, false);
    assert.strictEqual(run(1.5, { op: 'type_is', value: 'number' }).ok, true);
    assert.deepStrictEqual(run('x', { op: 'type_is', value: 'number' }).params, { path: '', expected: '"number"', actual: '"string"' });
});

test('count_is: array length, string length, object key count', () => {
    assert.strictEqual(run([1, 2, 3], { op: 'count_is', value: { cmp: 'eq', n: 3 } }).ok, true);
    assert.strictEqual(run('abcd', { op: 'count_is', value: { cmp: 'gte', n: 4 } }).ok, true);
    assert.strictEqual(run({ a: 1, b: 2 }, { op: 'count_is', value: { cmp: 'lte', n: 1 } }).code, 'wrong_count');
    assert.strictEqual(run(7, { op: 'count_is', value: { cmp: 'eq', n: 1 } }).code, 'not_countable');
    assert.strictEqual(run([], { op: 'count_is', value: { cmp: 'eq', n: 0 } }).ok, true);
});

test('paths: whole result, nested, index, missing', () => {
    const target = { items: [{ name: 'first' }, { name: 'second' }], total: 2 };
    assert.strictEqual(run(target, { op: 'equals', path: 'items[0].name', value: 'first' }).ok, true);
    assert.strictEqual(run(target, { op: 'equals', path: 'items[-1].name', value: 'second' }).ok, true);
    assert.strictEqual(run(target, { op: 'equals', path: 'total', value: 2 }).ok, true);
    assert.strictEqual(run(target, { op: 'type_is', path: '$', value: 'object' }).ok, true);
    const missing = run(target, { op: 'equals', path: 'items[5].name', value: 'x' });
    assert.deepStrictEqual(missing, { id: 'a', ok: false, code: 'path_missing', params: { path: 'items[5].name' } });
    assert.strictEqual(run([{ sku: 1 }, { sku: 2 }], { op: 'equals', path: '[*].sku', value: [1, 2] }).ok, true);
    assert.strictEqual(run({ message: 'boom' }, { op: 'contains', path: 'message', value: 'boo' }).ok, true);
});

test('values in params are cut to 200 characters of JSON text', () => {
    const long = 'x'.repeat(5000);
    const r = run(long, { op: 'equals', value: 'y' });
    assert.strictEqual(r.params.actual.length, 201);
    assert.ok(r.params.actual.endsWith('…'));
    assert.ok(r.params.expected.length <= 201);
});

test('deepEqual stops at absurd depth instead of overflowing', () => {
    let a = {}; let b = {};
    for (let i = 0; i < 5000; i++) { a = { n: a }; b = { n: b }; }
    assert.strictEqual(deepEqual(a, b), false);
});

test('validateAssertions accepts a good list', () => {
    const list = [
        { id: '1', op: 'equals', path: '', value: { a: 1 } },
        { id: '2', op: 'contains', path: 'items[0].name', value: 'x' },
        { id: '3', op: 'has_key', path: 'a', value: 'b' },
        { id: '4', op: 'type_is', path: 'a', value: 'array' },
        { id: '5', op: 'count_is', path: 'a', value: { cmp: 'gte', n: 0 } },
        { id: '6', op: 'not_equals', value: null },
    ];
    assert.deepStrictEqual(validateAssertions(list), { ok: true, errors: [] });
    assert.deepStrictEqual(validateAssertions([]), { ok: true, errors: [] });
});

test('validateAssertions names the index and the problem', () => {
    const bad = (a) => validateAssertions([a]);
    assert.strictEqual(bad({ id: '', op: 'equals', value: 1 }).ok, false);
    assert.strictEqual(bad({ id: 'x'.repeat(41), op: 'equals', value: 1 }).ok, false);
    assert.match(bad({ id: 'a', op: 'eval', value: 1 }).errors[0].message, /op must be/);
    assert.strictEqual(bad({ id: 'a', op: 'equals' }).ok, false, 'equals needs a value');
    assert.strictEqual(bad({ id: 'a', op: 'has_key', value: '' }).ok, false);
    assert.strictEqual(bad({ id: 'a', op: 'type_is', value: 'date' }).ok, false);
    assert.strictEqual(bad({ id: 'a', op: 'count_is', value: { cmp: 'gt', n: 1 } }).ok, false);
    assert.strictEqual(bad({ id: 'a', op: 'count_is', value: { cmp: 'eq', n: -1 } }).ok, false);
    assert.strictEqual(bad({ id: 'a', op: 'count_is', value: { cmp: 'eq', n: 1.5 } }).ok, false);
    assert.strictEqual(bad({ id: 'a', op: 'contains', value: null }).ok, false);
    assert.strictEqual(bad({ id: 'a', op: 'equals', path: 'a'.repeat(501), value: 1 }).ok, false);
    assert.match(bad({ id: 'a', op: 'equals', path: 'a[', value: 1 }).errors[0].message, /path/);
    assert.match(bad({ id: 'a', op: 'equals', value: 'x'.repeat(17 * 1024) }).errors[0].message, /16 KB/);
    assert.strictEqual(bad('nope').ok, false);
    const two = validateAssertions([{ id: 'a', op: 'equals', value: 1 }, { id: 'a', op: 'equals', value: 1 }]);
    assert.deepStrictEqual(two.errors.map((e) => e.index), [1]);
    assert.strictEqual(validateAssertions('x').ok, false);
});

test('validateAssertions honours the env cap, 0 meaning unlimited', () => {
    const list = Array.from({ length: 3 }, (_, i) => ({ id: String(i), op: 'type_is', value: 'string' }));
    const prev = process.env.AUTOMATION_TEST_ASSERTIONS_MAX;
    try {
        process.env.AUTOMATION_TEST_ASSERTIONS_MAX = '2';
        assert.strictEqual(validateAssertions(list).ok, false);
        process.env.AUTOMATION_TEST_ASSERTIONS_MAX = '0';
        assert.strictEqual(validateAssertions(list).ok, true);
    } finally {
        if (prev === undefined) delete process.env.AUTOMATION_TEST_ASSERTIONS_MAX; else process.env.AUTOMATION_TEST_ASSERTIONS_MAX = prev;
    }
});
