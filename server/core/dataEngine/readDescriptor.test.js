/**
 * The read-descriptor normaliser: the field lists every App Studio read entry
 * point passes on to the compiler. The exact shape is the contract: the
 * callers used to build these objects by hand, and the objects must stay the
 * ones they built (same keys, same order, `undefined` kept as a present key).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { recordListDescriptor, aggregateDescriptor, resolveSearch } = require('./readDescriptor.mts');

const BINDING = {
    kind: 'records', tableId: 'tbl_1', filters: [{ field: 'a', op: 'eq', value: 1 }], sort: [{ field: 'a' }],
    groupBy: [{ field: 'g' }], aggregates: [{ fn: 'count' }], cursor: 'c', limit: 9,
};

test('a record list picks filters and sort, then the caller\'s own fields', () => {
    const out = recordListDescriptor(BINDING, { cursor: 'c2', limit: 3, dialect: 'pg' });
    assert.deepStrictEqual(out, { filters: BINDING.filters, sort: BINDING.sort, cursor: 'c2', limit: 3, dialect: 'pg' });
    assert.deepStrictEqual(Object.keys(out), ['filters', 'sort', 'cursor', 'limit', 'dialect']);
});

test('an aggregate picks filters, groupBy, aggregates and sort, then the caller\'s own fields', () => {
    const out = aggregateDescriptor(BINDING, { limit: 4 });
    assert.deepStrictEqual(out, {
        filters: BINDING.filters, groupBy: BINDING.groupBy, aggregates: BINDING.aggregates, sort: BINDING.sort, limit: 4,
    });
    assert.deepStrictEqual(Object.keys(out), ['filters', 'groupBy', 'aggregates', 'sort', 'limit']);
});

test('the caller\'s own value wins and keeps the picked position', () => {
    const resolved = [{ field: 'b', op: 'eq', value: 2 }];
    const out = recordListDescriptor(BINDING, { filters: resolved, limit: 1 });
    assert.strictEqual(out.filters, resolved);
    assert.deepStrictEqual(Object.keys(out), ['filters', 'sort', 'limit']);
});

test('fields the compiler does not take from a read are not passed on', () => {
    const list = recordListDescriptor(BINDING);
    const agg = aggregateDescriptor(BINDING);
    for (const key of ['kind', 'tableId', 'cursor', 'limit']) {
        assert.ok(!(key in list), `record list leaves ${key} to the caller`);
        assert.ok(!(key in agg), `aggregate leaves ${key} to the caller`);
    }
});

test('a missing field stays a present key holding undefined, as the hand-built objects had it', () => {
    const out = aggregateDescriptor({}, { limit: undefined });
    assert.deepStrictEqual(out, { filters: undefined, groupBy: undefined, aggregates: undefined, sort: undefined, limit: undefined });
});

test('match and search travel only when the read carries them; an aggregate takes match alone', () => {
    const asked = { ...BINDING, match: 'any', search: { value: 'x', fields: ['a'] } };
    const list = recordListDescriptor(asked, { limit: 1 });
    assert.deepStrictEqual(Object.keys(list), ['filters', 'sort', 'match', 'search', 'limit']);
    assert.deepStrictEqual(Object.keys(aggregateDescriptor(asked)), ['filters', 'groupBy', 'aggregates', 'sort', 'match']);
    assert.deepStrictEqual(Object.keys(recordListDescriptor({ ...BINDING, match: null, search: null })), ['filters', 'sort']);
});

test('a search value is made literal, or the search is left out when it holds no text', () => {
    const fields = ['a'];
    const formula = { value: { kind: 'formula', expr: 'vars.q' }, fields };
    assert.deepStrictEqual(resolveSearch({ value: 'abc', fields }), { value: 'abc', fields });
    assert.deepStrictEqual(resolveSearch(formula, () => 'xyz'), { value: 'xyz', fields });
    assert.deepStrictEqual(resolveSearch({ value: 7, fields }), { value: '7', fields });
    assert.strictEqual(resolveSearch(formula, () => undefined), null);
    assert.strictEqual(resolveSearch(formula, () => '  '), null);
    assert.strictEqual(resolveSearch(formula), null);
    assert.strictEqual(resolveSearch('x'), null);
    assert.strictEqual(resolveSearch(undefined), null);
});
