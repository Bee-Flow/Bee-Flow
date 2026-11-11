// @typecheck strict
/**
 * The filter-tree, column-comparison and orderBy list cases of the SQL snapshot
 * (queryCompiler.snapshot.fixture.js appends them to LIST_CASES): `all` / `any` /
 * `not` groups to depth 3, { field, op, otherField } and orderBy on up to 3
 * columns with its expanded keyset. Added after the cases there; none of those changed.
 */

'use strict';

/** A title clause, the leaf the tree cases are built from. */
const T = (/** @type {string} */ v) => ({ field: 'title', op: 'eq', value: v });

/**
 * @param {(v: unknown, i: string) => string} cursorOf  a keyset cursor of (value, id)
 * @param {{ where: string, params: unknown[] }} allow  the allow-all access filter
 * @returns {Array<[string, Record<string, unknown>, unknown?]>}
 */
function treeListCases(cursorOf, allow) {
    const ALLOW = allow;
    /** An orderBy cursor: every sort value in order, the id last. */
    const orderCursorOf = (/** @type {unknown[]} */ values) => cursorOf(values, String(values[values.length - 1]));
    return [
        ['tree-all-in-any', { filters: [{ any: [{ all: [T('a'), { field: 'amount', op: 'gt', value: 1 }] }, T('b')] }] }],
        ['tree-all-top', { filters: [{ all: [T('a'), { field: 'done', op: 'eq', value: true }] }] }],
        ['tree-all-single', { filters: [{ all: [T('a')] }] }],
        ['tree-not-clause', { filters: [{ not: T('a') }] }],
        ['tree-not-any', { filters: [T('z'), { not: { any: [T('a'), { field: 'region', op: 'in', value: [] }] } }] }],
        ['tree-depth-3', { filters: [{ any: [{ all: [{ not: T('a') }, T('b')] }, { not: { all: [T('c'), T('d')] } }] }] }],
        ['tree-any-in-all-in-any', { filters: [{ any: [{ all: [{ any: [T('a'), T('b')] }, T('c')] }] }] }],
        ['tree-match-any', { match: 'any', filters: [{ all: [T('a'), T('b')] }, { not: T('c') }] }],
        ['tree-with-search-and-cursor', {
            filters: [{ not: { any: [T('a'), T('b')] } }], search: { value: 'q', fields: ['title'] },
            sort: [{ field: 'amount', dir: 'asc' }], cursor: cursorOf(3, 'rec_1'),
        }],
        ['tree-allow-access', { filters: [{ any: [{ not: T('a') }, T('b')] }] }, ALLOW],
        ['other-field-number', { filters: [{ field: 'amount', op: 'gte', otherField: 'amount' }] }],
        ['other-field-bool-neq', { filters: [{ field: 'done', op: 'neq', otherField: 'done' }] }],
        ['other-field-eq-text', { filters: [{ field: 'title', op: 'eq', otherField: 'region' }] }],
        ['other-field-system', { filters: [{ field: 'due', op: 'lte', otherField: 'updated_at' }] }],
        ['other-field-in-tree', { filters: [{ any: [{ field: 'created_by', op: 'neq', otherField: 'owner_ref' }, { not: { field: 'due', op: 'lt', otherField: 'created_at' } }] }] }],
        ['order-by-one', { orderBy: [{ field: 'title', dir: 'asc' }] }],
        ['order-by-object', { orderBy: { field: 'amount' } }],
        ['order-by-three-mixed', { orderBy: [{ field: 'region', dir: 'asc' }, { field: 'amount', dir: 'desc' }, { field: 'title', direction: 'ASC' }] }],
        ['order-by-wins-over-sort', { sort: [{ field: 'title', dir: 'asc' }], orderBy: [{ field: 'amount', dir: 'desc' }, { field: 'due', dir: 'asc' }] }],
        ['order-by-with-id', { orderBy: [{ field: 'region', dir: 'desc' }, { field: 'id', dir: 'asc' }, { field: 'title', dir: 'asc' }] }],
        ['order-by-empty-list-is-sort', { sort: [{ field: 'title', dir: 'asc' }], orderBy: [] }],
        ['order-by-cursor', {
            orderBy: [{ field: 'region', dir: 'asc' }, { field: 'amount', dir: 'desc' }],
            cursor: orderCursorOf(['eu', 12, 'rec_3']), limit: 10,
        }],
        ['order-by-cursor-nulls', {
            filters: [T('a')],
            orderBy: [{ field: 'region', dir: 'asc' }, { field: 'amount', dir: 'desc' }, { field: 'due', dir: 'asc' }],
            cursor: orderCursorOf([null, 12, null, 'rec_3']),
        }],
        ['order-by-cursor-one', { orderBy: [{ field: 'amount', dir: 'desc' }], cursor: orderCursorOf([5, 'rec_9']) }],
        ['err-tree-too-deep', { filters: [{ any: [{ all: [{ not: { all: [T('a')] } }] }] }] }],
        ['err-all-empty', { filters: [{ all: [] }] }],
        ['err-tree-unknown-field', { filters: [{ not: { all: [T('a'), { field: 'ssn', op: 'eq', value: 1 }] } }] }],
        ['err-tree-too-many', { filters: [{ not: { all: Array.from({ length: 51 }, () => ({ field: 'title', op: 'isNull' })) } }] }],
        ['err-not-list', { filters: [{ not: [T('a')] }] }],
        ['err-other-field-unknown', { filters: [{ field: 'amount', op: 'gt', otherField: 'ssn' }] }],
        ['err-other-field-computed', { filters: [{ field: 'amount', op: 'gt', otherField: 'total' }] }],
        ['err-other-field-op', { filters: [{ field: 'title', op: 'contains', otherField: 'region' }] }],
        ['err-other-field-kinds', { filters: [{ field: 'title', op: 'eq', otherField: 'amount' }] }],
        ['err-other-field-json', { filters: [{ field: 'tags', op: 'eq', otherField: 'tags' }] }],
        ['err-other-field-and-value', { filters: [{ field: 'amount', op: 'gt', otherField: 'amount', value: 3 }] }],
        ['err-other-field-number-text', { filters: [{ field: 'amount', op: 'gt', otherField: 'stored_total' }] }],
        ['err-order-by-too-many', { orderBy: [{ field: 'region' }, { field: 'amount' }, { field: 'title' }, { field: 'due' }] }],
        ['err-order-by-unknown', { orderBy: [{ field: 'title' }, { field: 'nope' }] }],
        ['err-order-by-computed', { orderBy: [{ field: 'total' }] }],
        ['err-order-by-twice', { orderBy: [{ field: 'title' }, { field: 'title', dir: 'asc' }] }],
        ['err-order-by-no-field', { orderBy: [{ dir: 'asc' }] }],
        ['err-order-by-legacy-cursor', { orderBy: [{ field: 'amount' }], cursor: cursorOf(12, 'rec_3') }],
        ['err-order-by-cursor-length', { orderBy: [{ field: 'amount' }, { field: 'title' }], cursor: orderCursorOf([12, 'rec_3']) }],
        ['err-order-by-cursor-object', { orderBy: [{ field: 'amount' }], cursor: orderCursorOf([{ a: 1 }, 'rec_3']) }],
    ];
}

module.exports = { treeListCases, T };
