/**
 * The server step reads (stepDataSource.resolveFilters, and runBindings'
 * up-front check through filtersBlocked) resolve `{ any: [...] }` groups with
 * the shared loop, keeping this file's own rules: '' counts as no value,
 * malformed entries drop, and a required clause without a value reads nothing.
 *
 * Run: node --test appStudio/stepDataSource.anyGroup.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
const { _resolveFilters: resolveFilters, filtersBlocked } = require('./stepDataSource');

const SCOPE = { status: 'open', none: '', missing: undefined };
const resolveValue = (b) => (b.kind === 'formula' ? SCOPE[b.expr] : undefined);
const F = (expr) => ({ kind: 'formula', expr });

test('a group resolves its formula values and keeps both clauses', () => {
    const { filters, blocked } = resolveFilters([{ any: [
        { field: 'status', op: 'eq', value: F('status') },
        { field: 'priority', op: 'eq', value: 'high' },
    ] }], resolveValue);
    assert.strictEqual(blocked, false);
    assert.deepStrictEqual(filters, [{ any: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'priority', op: 'eq', value: 'high' }] }]);
});

test("a clause without a value ('' included) drops out of its group; an emptied group drops", () => {
    const res = resolveFilters([
        { field: 'kind', op: 'eq', value: 'x' },
        { any: [{ field: 'status', op: 'eq', value: F('none') }, { field: 'priority', op: 'eq', value: F('missing') }] },
    ], resolveValue);
    assert.deepStrictEqual(res, { filters: [{ field: 'kind', op: 'eq', value: 'x' }], blocked: false });
});

test('a required group or a required clause in a group without a value reads nothing', () => {
    const empty = { field: 'status', op: 'eq', value: F('none') };
    assert.strictEqual(resolveFilters([{ any: [empty], required: true }], resolveValue).blocked, true);
    assert.strictEqual(resolveFilters([{ any: [{ ...empty, required: true }, { field: 'a', op: 'eq', value: 1 }] }], resolveValue).blocked, true);
    assert.strictEqual(filtersBlocked([{ any: [empty], required: true }], resolveValue), true);
    assert.strictEqual(filtersBlocked([{ any: [empty] }], resolveValue), false);
});

test('flat lists: malformed entries drop, isNull/isNotNull keep their clause', () => {
    const res = resolveFilters([null, 'x', { field: 'a', op: 'isNull' }, { field: 'c', op: 'isNotNull' }, { field: 'b', op: 'eq', value: 2, required: true }], resolveValue);
    assert.deepStrictEqual(res, { filters: [{ field: 'a', op: 'isNull' }, { field: 'c', op: 'isNotNull' }, { field: 'b', op: 'eq', value: 2 }], blocked: false });
    assert.strictEqual(filtersBlocked([{ field: 'a', op: 'eq', value: F('none'), required: true }], resolveValue), true);
});
