/**
 * The read-descriptor normaliser: the field lists every App Studio read entry
 * point passes on to the compiler. The exact shape is the contract: the
 * callers used to build these objects by hand, and the objects must stay the
 * ones they built (same keys, same order, `undefined` kept as a present key).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { recordListDescriptor, aggregateDescriptor } = require('./readDescriptor.mts');

const BINDING = {
    kind: 'records', tableId: 'tbl_1', filters: [{ field: 'a', op: 'eq', value: 1 }], sort: [{ field: 'a' }],
    groupBy: [{ field: 'g' }], aggregates: [{ fn: 'count' }], cursor: 'c', limit: 9, match: 'any', search: { value: 'x' },
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
    for (const key of ['kind', 'tableId', 'cursor', 'limit', 'match', 'search']) {
        assert.ok(!(key in list), `record list leaves ${key} to the caller`);
        assert.ok(!(key in agg), `aggregate leaves ${key} to the caller`);
    }
});

test('a missing field stays a present key holding undefined, as the hand-built objects had it', () => {
    const out = aggregateDescriptor({}, { limit: undefined });
    assert.deepStrictEqual(out, { filters: undefined, groupBy: undefined, aggregates: undefined, sort: undefined, limit: undefined });
});

test('groupFilter travels on an aggregate when the read has one, never on a record list', () => {
    const groupFilter = [{ field: 'n', op: 'gt', value: 1 }];
    assert.deepStrictEqual(aggregateDescriptor({ ...BINDING, groupFilter }).groupFilter, groupFilter);
    assert.ok(!('groupFilter' in aggregateDescriptor(BINDING)));
    assert.ok(!('groupFilter' in aggregateDescriptor({ ...BINDING, groupFilter: null })));
    assert.ok(!('groupFilter' in recordListDescriptor({ ...BINDING, groupFilter })));
});
