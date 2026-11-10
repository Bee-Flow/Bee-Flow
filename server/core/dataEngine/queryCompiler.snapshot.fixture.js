// @typecheck
/**
 * The read descriptors the SQL snapshot pins (queryCompiler.snapshot.test.js).
 *
 * Every case is compiled in BOTH dialects. The set is drawn from the existing
 * compiler tests and from what the App Studio read paths really send: lists,
 * get by id, every filter operator, `{ any: [...] }` groups, `match: 'any'`, search,
 * case-insensitive `eq`, sort, keyset cursors, limits, aggregates with every
 * function and every date bucket, percentiles, and the access filters the row
 * rules produce. Invalid descriptors are pinned too, with the error they raise,
 * so a refactor cannot change which check fires first.
 *
 * Adding a case changes the golden: re-capture with
 *   UPDATE_GOLDEN=1 node --test core/dataEngine/queryCompiler.snapshot.test.js
 * and say so in the commit. A change to an EXISTING entry is a behaviour change.
 */

'use strict';

const TABLE = {
    id: 'tbl_snap01',
    key: 'tasks',
    fields: [
        { id: 'fld_1', key: 'title', type: 'text' },
        { id: 'fld_2', key: 'amount', type: 'number', subtype: 'integer' },
        { id: 'fld_3', key: 'region', type: 'text' },
        { id: 'fld_4', key: 'done', type: 'bool' },
        { id: 'fld_5', key: 'due', type: 'datetime' },
        { id: 'fld_6', key: 'tags', type: 'multiselect', options: ['a', 'b'] },
        { id: 'fld_7', key: 'total', type: 'computed', computed: { expr: 'amount * 2' } },
        { id: 'fld_8', key: 'stored_total', type: 'computed', computed: { expr: 'amount * 2', stored: true } },
        { id: 'fld_9', key: 'owner_ref', type: 'relation', relation: { tableId: 'tbl_other' } },
    ],
    access: {
        default: 'none',
        roles: {
            viewer: { read: 'own', create: false, update: 'none', delete: 'none' },
            editor: { read: 'all', create: true, update: 'all', delete: 'all' },
            regional: { read: 'all', create: false, update: 'own', delete: 'none' },
            ownregional: { read: 'own', create: false, update: 'own', delete: 'own' },
            public: { read: 'all', create: false, update: 'none', delete: 'none' },
        },
        rowFilters: {
            regional: 'record.region == viewer.region',
            ownregional: 'record.amount >= 100 && !(record.done == true) || record.title != "x"',
            public: 'record.done == true',
        },
    },
};

const ACCESS = { where: '"created_by" = ?', params: ['viewer-1'] };
const ALLOW = { where: '1=1', params: [] };

/** A keyset cursor of (value, id), built the way encodeCursor builds one. */
const cursorOf = (/** @type {unknown} */ v, /** @type {string} */ i) => Buffer.from(JSON.stringify({ v, i }), 'utf8').toString('base64url');

/** One clause per operator, with a value of the shape that operator takes. */
const OP_CLAUSES = [
    ['eq', { field: 'title', op: 'eq', value: 'Hello' }],
    ['eq-number', { field: 'amount', op: 'eq', value: 7 }],
    ['eq-bool', { field: 'done', op: 'eq', value: true }],
    ['eq-bool-false', { field: 'done', op: 'eq', value: false }],
    ['eq-null', { field: 'title', op: 'eq', value: null }],
    ['eq-ci', { field: 'title', op: 'eq', value: 'He%l_o', ci: true }],
    ['eq-ci-number', { field: 'amount', op: 'eq', value: 3, ci: true }],
    ['neq', { field: 'title', op: 'neq', value: 'x' }],
    ['gt', { field: 'amount', op: 'gt', value: 1 }],
    ['gte', { field: 'amount', op: 'gte', value: 2 }],
    ['lt', { field: 'amount', op: 'lt', value: 3 }],
    ['lte', { field: 'due', op: 'lte', value: '2026-01-01T00:00:00Z' }],
    ['contains', { field: 'title', op: 'contains', value: '100%_x\\' }],
    ['notContains', { field: 'title', op: 'notContains', value: 'spam' }],
    ['startsWith', { field: 'title', op: 'startsWith', value: 'Re:' }],
    ['endsWith', { field: 'title', op: 'endsWith', value: '.pdf' }],
    ['in', { field: 'region', op: 'in', value: ['eu', 'us', 3, true] }],
    ['in-empty', { field: 'region', op: 'in', value: [] }],
    ['notIn', { field: 'region', op: 'notIn', value: ['eu'] }],
    ['notIn-empty', { field: 'region', op: 'notIn', value: [] }],
    ['between', { field: 'amount', op: 'between', value: [1, 10] }],
    ['between-dates', { field: 'due', op: 'between', value: ['2026-01-01', '2026-12-31'] }],
    ['isNull', { field: 'title', op: 'isNull' }],
    ['isNotNull', { field: 'owner_ref', op: 'isNotNull' }],
    ['system-column', { field: 'created_at', op: 'gte', value: '2026-01-01' }],
    ['stored-computed', { field: 'stored_total', op: 'gt', value: 4 }],
];

/**
 * Descriptors for compileRecordList: [name, opts, access?].
 * @type {Array<[string, Record<string, unknown> | undefined, unknown?]>}
 */
const LIST_CASES = [
    ['empty', {}],
    ['no-opts', undefined],
    ['limit-5', { limit: 5 }],
    ['limit-string', { limit: '20' }],
    ['limit-zero', { limit: 0 }],
    ['limit-negative', { limit: -5 }],
    ['limit-garbage', { limit: 'abc' }],
    ['limit-huge', { limit: 10_000_000 }],
    ['limit-max-limit', { limit: 900, maxLimit: 100 }],
    ['max-limit-only', { maxLimit: 10 }],
    ['max-limit-bad', { limit: 30, maxLimit: -1 }],
    ['sort-asc', { sort: [{ field: 'title', dir: 'asc' }] }],
    ['sort-desc-object', { sort: { field: 'amount', dir: 'desc' } }],
    ['sort-direction-key', { sort: [{ field: 'amount', direction: 'ASC' }] }],
    ['sort-two-entries', { sort: [{ field: 'region', dir: 'asc' }, { field: 'title', dir: 'desc' }] }],
    ['sort-empty-array', { sort: [] }],
    ['sort-no-field', { sort: [{ dir: 'asc' }] }],
    ['sort-system', { sort: [{ field: 'updated_at', dir: 'asc' }] }],
    ['cursor-desc', { cursor: cursorOf('2026-03-01T00:00:00Z', 'rec_9') }],
    ['cursor-asc', { sort: [{ field: 'amount', dir: 'asc' }], cursor: cursorOf(12, 'rec_3'), limit: 10 }],
    ['cursor-malformed', { cursor: 'not-a-cursor' }],
    ['cursor-null-value', { cursor: cursorOf(null, 'rec_1') }],
    ['cursor-non-string', { cursor: 42 }],
    ['two-filters', { filters: [{ field: 'title', op: 'eq', value: 'a' }, { field: 'amount', op: 'gt', value: 1 }] }],
    ['match-all', { match: 'all', filters: [{ field: 'title', op: 'eq', value: 'a' }, { field: 'amount', op: 'gt', value: 1 }] }],
    ['match-any', { match: 'any', filters: [{ field: 'title', op: 'eq', value: 'a' }, { field: 'amount', op: 'gt', value: 1 }] }],
    ['match-any-one', { match: 'any', filters: [{ field: 'title', op: 'eq', value: 'a' }] }],
    ['match-any-none', { match: 'any' }],
    ['any-group', { filters: [{ any: [{ field: 'region', op: 'eq', value: 'eu' }, { field: 'region', op: 'eq', value: 'us' }] }] }],
    ['any-group-single', { filters: [{ any: [{ field: 'region', op: 'eq', value: 'eu' }] }] }],
    ['any-group-mixed', {
        filters: [
            { field: 'amount', op: 'gt', value: 5 },
            { any: [{ field: 'title', op: 'contains', value: 'x' }, { field: 'amount', op: 'between', value: [1, 2] }] },
            { field: 'done', op: 'eq', value: false },
        ],
    }],
    ['any-group-match-any', {
        match: 'any',
        filters: [
            { any: [{ field: 'region', op: 'eq', value: 'eu' }, { field: 'region', op: 'in', value: [] }] },
            { field: 'title', op: 'isNull' },
        ],
    }],
    ['search', { search: { value: 'foo%', fields: ['title', 'region'] } }],
    ['search-with-filters-any', {
        match: 'any',
        filters: [{ field: 'title', op: 'eq', value: 'a' }, { field: 'amount', op: 'gt', value: 1 }],
        search: { value: 'q', fields: ['title'] },
    }],
    ['search-null', { search: null }],
    ['search-not-object', { search: 'foo' }],
    ['everything', {
        filters: [{ field: 'region', op: 'in', value: ['eu'] }, { any: [{ field: 'done', op: 'eq', value: true }, { field: 'amount', op: 'isNull' }] }],
        match: 'all',
        search: { value: 'abc', fields: ['title'] },
        sort: [{ field: 'due', dir: 'asc' }],
        cursor: cursorOf('2026-02-02', 'rec_x'),
        limit: 25,
        maxLimit: 200,
    }],
    ['allow-access', { filters: [{ field: 'title', op: 'eq', value: 'a' }] }, ALLOW],
    ['extra-unknown-keys-ignored', { filters: [], expand: [{ field: 'owner_ref' }], fields: ['title'], total: true, having: [] }],
    // Invalid descriptors: the error is the snapshot.
    ['err-unknown-field', { filters: [{ field: 'ssn', op: 'eq', value: 1 }] }],
    ['err-unknown-op', { filters: [{ field: 'title', op: 'regex', value: 'x' }] }],
    ['err-computed', { filters: [{ field: 'total', op: 'gt', value: 1 }] }],
    ['err-filter-not-object', { filters: ['title'] }],
    ['err-filter-array-entry', { filters: [[{ field: 'title', op: 'eq', value: 1 }]] }],
    ['err-filters-not-array', { filters: { field: 'title', op: 'eq', value: 1 } }],
    ['err-field-empty', { filters: [{ field: '', op: 'eq', value: 1 }] }],
    ['err-field-proto', { filters: [{ field: '__proto__', op: 'eq', value: 1 }] }],
    ['err-value-object', { filters: [{ field: 'title', op: 'eq', value: { a: 1 } }] }],
    ['err-in-not-array', { filters: [{ field: 'region', op: 'in', value: 'a,b' }] }],
    ['err-notIn-not-array', { filters: [{ field: 'region', op: 'notIn', value: 'a' }] }],
    ['err-in-too-many', { filters: [{ field: 'region', op: 'in', value: Array.from({ length: 201 }, (_, i) => i) }] }],
    ['err-in-element-object', { filters: [{ field: 'region', op: 'in', value: [{}] }] }],
    ['err-between-shape', { filters: [{ field: 'amount', op: 'between', value: [1] }] }],
    ['err-between-not-array', { filters: [{ field: 'amount', op: 'between', value: 3 }] }],
    ['err-too-many-filters', { filters: Array.from({ length: 51 }, () => ({ field: 'title', op: 'isNull' })) }],
    ['err-too-many-in-groups', { filters: [{ any: Array.from({ length: 51 }, () => ({ field: 'title', op: 'isNull' })) }] }],
    ['err-match-bad', { match: 'some' }],
    ['err-any-empty', { filters: [{ any: [] }] }],
    ['err-any-nested', { filters: [{ any: [{ any: [{ field: 'title', op: 'isNull' }] }] }] }],
    ['err-any-with-field', { filters: [{ field: 'title', any: [{ field: 'title', op: 'isNull' }] }] }],
    ['err-search-empty', { search: { value: '', fields: ['title'] } }],
    ['err-search-no-fields', { search: { value: 'x', fields: [] } }],
    ['err-search-too-many', { search: { value: 'x', fields: Array.from({ length: 51 }, () => 'title') } }],
    ['err-search-unknown', { search: { value: 'x', fields: ['ssn'] } }],
    ['err-sort-unknown', { sort: [{ field: 'nope' }] }],
    ['err-sort-computed', { sort: [{ field: 'total' }] }],
    ['err-no-access', {}, null],
    ['err-access-no-params', {}, { where: 'x' }],
    ['err-access-empty-where', {}, { where: '', params: [] }],
    ['err-bad-dialect', { dialect: 'mysql' }],
];
for (const [name, clause] of OP_CLAUSES) LIST_CASES.push([`op-${name}`, { filters: [clause] }]);
for (const [name, clause] of OP_CLAUSES) LIST_CASES.push([`op-${name}-in-any`, { filters: [{ any: [clause, { field: 'title', op: 'isNull' }] }] }]);

// Filter trees ({ all } / { any } / { not } to depth 3), column comparisons
// ({ field, op, otherField }) and orderBy (up to 3 columns, expanded keyset).
// Added after the cases above; none of those changed.
const T = (/** @type {string} */ v) => ({ field: 'title', op: 'eq', value: v });
/** An orderBy cursor: every sort value in order, the id last. */
const orderCursorOf = (/** @type {unknown[]} */ values) => cursorOf(values, String(values[values.length - 1]));
LIST_CASES.push(
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
);

/**
 * Descriptors for compileAggregate: [name, opts, access?].
 * @type {Array<[string, Record<string, unknown> | undefined, unknown?]>}
 */
const AGGREGATE_CASES = [
    ['count-all', { aggregates: [{ fn: 'count' }] }],
    ['count-star', { aggregates: [{ fn: 'count', field: '*', as: 'n' }] }],
    ['count-field', { aggregates: [{ fn: 'count', field: 'title' }] }],
    ['sum', { aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] }],
    ['avg', { aggregates: [{ fn: 'avg', field: 'amount' }] }],
    ['min', { aggregates: [{ fn: 'min', field: 'due' }] }],
    ['max', { aggregates: [{ fn: 'max', field: 'stored_total' }] }],
    ['group-only', { groupBy: [{ field: 'region' }] }],
    ['group-as', { groupBy: [{ field: 'region', as: 'Region' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['group-two', { groupBy: [{ field: 'region' }, { field: 'done' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] }],
    ['group-system', { groupBy: [{ field: 'created_by' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['filters', { filters: [{ field: 'done', op: 'eq', value: true }, { field: 'title', op: 'contains', value: 'x' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['filters-any-group', { filters: [{ any: [{ field: 'region', op: 'eq', value: 'eu' }, { field: 'region', op: 'in', value: [] }] }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['match-any', { match: 'any', filters: [{ field: 'title', op: 'eq', value: 'a' }, { field: 'amount', op: 'gt', value: 1 }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['search-ignored', { search: { value: 'x', fields: ['title'] }, aggregates: [{ fn: 'count', as: 'n' }] }],
    ['sort-alias-asc', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], sort: [{ field: 'n', dir: 'asc' }] }],
    ['sort-alias-object', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], sort: { field: 'region', direction: 'DESC' } }],
    ['sort-no-field', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], sort: [{}] }],
    ['limit', { aggregates: [{ fn: 'count' }], limit: 7 }],
    ['limit-huge', { aggregates: [{ fn: 'count' }], limit: 999999 }],
    ['limit-garbage', { aggregates: [{ fn: 'count' }], limit: 'x' }],
    ['max-limit-ignored', { aggregates: [{ fn: 'count' }], limit: 900, maxLimit: 10 }],
    ['p50', { aggregates: [{ fn: 'p50', field: 'amount', as: 'median' }] }],
    ['p90-default-alias', { aggregates: [{ fn: 'p90', field: 'amount' }] }],
    ['p50-grouped', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'p90', field: 'amount', as: 'p90_amount' }] }],
    ['p50-mixed', {
        groupBy: [{ field: 'region' }, { field: 'due', bucket: 'month', as: 'month' }],
        aggregates: [{ fn: 'count', as: 'n' }, { fn: 'p50', field: 'amount', as: 'median' }, { fn: 'sum', field: 'amount', as: 'total' }, { fn: 'p90', field: 'stored_total', as: 'p90' }],
        filters: [{ field: 'done', op: 'eq', value: false }],
        sort: [{ field: 'median', dir: 'asc' }],
        limit: 12,
    }],
    ['p50-ungrouped-two', { aggregates: [{ fn: 'p50', field: 'amount', as: 'median' }, { fn: 'p90', field: 'amount', as: 'p90' }] }],
    ['everything', {
        filters: [{ field: 'region', op: 'notIn', value: ['x'] }],
        groupBy: [{ field: 'due', bucket: 'week' }, { field: 'region', as: 'r' }],
        aggregates: [{ fn: 'count', as: 'n' }, { fn: 'avg', field: 'amount', as: 'mean' }, { fn: 'max', field: 'due', as: 'last' }],
        sort: [{ field: 'n', dir: 'desc' }],
        limit: 100,
    }],
    ['allow-access', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }] }, ALLOW],
    ['extra-unknown-keys-ignored', { aggregates: [{ fn: 'count', as: 'n' }], having: [{ field: 'n', op: 'gt', value: 1 }], expand: [] }],
    // Invalid descriptors.
    ['err-empty', {}],
    ['err-no-opts', undefined],
    ['err-unknown-fn', { aggregates: [{ fn: 'median', field: 'amount' }] }],
    ['err-unknown-field', { aggregates: [{ fn: 'sum', field: 'ssn' }] }],
    ['err-sum-no-field', { aggregates: [{ fn: 'sum' }] }],
    ['err-computed', { aggregates: [{ fn: 'sum', field: 'total' }] }],
    ['err-agg-not-object', { aggregates: ['count'] }],
    ['err-group-not-object', { groupBy: ['region'] }],
    ['err-group-unknown', { groupBy: [{ field: 'nope' }] }],
    ['err-bucket', { groupBy: [{ field: 'due', bucket: 'decade' }] }],
    ['err-alias', { aggregates: [{ fn: 'count', as: 'a"; DROP' }] }],
    ['err-group-alias', { groupBy: [{ field: 'region', as: '1x' }] }],
    ['err-sort-unknown', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], sort: [{ field: 'title' }] }],
    ['err-percentile-no-field', { aggregates: [{ fn: 'p50' }] }],
    ['err-percentile-star', { aggregates: [{ fn: 'p90', field: '*' }] }],
    ['err-too-many-groups', { groupBy: Array.from({ length: 9 }, (_, i) => ({ field: 'region', as: `g${i}` })) }],
    ['err-too-many-aggregates', { aggregates: Array.from({ length: 17 }, (_, i) => ({ fn: 'count', as: `c${i}` })) }],
    ['err-too-many-before-unknown', { groupBy: Array.from({ length: 9 }, () => ({ field: 'nope' })), aggregates: [{ fn: 'nope' }] }],
    ['err-filter-before-group', { filters: [{ field: 'nope', op: 'eq', value: 1 }], groupBy: [{ field: 'nope2' }] }],
    ['err-no-access', { aggregates: [{ fn: 'count' }] }, null],
];
AGGREGATE_CASES.push(
    ['tree-filters', { filters: [{ any: [{ all: [T('a'), { field: 'due', op: 'gt', otherField: 'created_at' }] }, { not: T('b') }] }], groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['tree-filters-percentile', { filters: [{ not: { any: [T('a'), T('b')] } }], groupBy: [{ field: 'region' }], aggregates: [{ fn: 'p50', field: 'amount', as: 'm' }] }],
    ['order-by-two', { groupBy: [{ field: 'region' }, { field: 'done' }], aggregates: [{ fn: 'count', as: 'n' }], orderBy: [{ field: 'n', dir: 'desc' }, { field: 'region', dir: 'asc' }] }],
    ['order-by-wins-over-sort', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], sort: [{ field: 'region' }], orderBy: { field: 'n', dir: 'asc' } }],
    ['order-by-percentile', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'p90', field: 'amount', as: 'm' }, { fn: 'count', as: 'n' }], orderBy: [{ field: 'm' }, { field: 'n', dir: 'asc' }, { field: 'region', dir: 'asc' }] }],
    ['err-order-by-unknown', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], orderBy: [{ field: 'n' }, { field: 'title' }] }],
    ['err-order-by-too-many', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], orderBy: [{ field: 'n' }, { field: 'region' }, { field: 'n2' }, { field: 'n3' }] }],
);
for (const bucket of ['hour', 'day', 'week', 'month', 'quarter', 'year']) {
    AGGREGATE_CASES.push([`bucket-${bucket}`, { groupBy: [{ field: 'due', bucket }], aggregates: [{ fn: 'count', as: 'n' }] }]);
    AGGREGATE_CASES.push([`bucket-${bucket}-percentile`, { groupBy: [{ field: 'created_at', bucket, as: 'b' }], aggregates: [{ fn: 'p50', field: 'amount', as: 'm' }] }]);
}

/** [name, id, access?] for compileGetById. */
const GET_BY_ID_CASES = [
    ['plain', 'rec_1'],
    ['allow', 'rec_2', ALLOW],
    ['err-empty-id', ''],
    ['err-number-id', 42],
    ['err-no-access', 'rec_1', null],
];

/** [name, keyField, keys, access?] for compileKeyIndex. */
const KEY_INDEX_CASES = [
    ['text', 'title', ['a', 'b', null, '', undefined, 'c']],
    ['bool', 'done', [true, false]],
    ['number', 'amount', [1, 2, 3]],
    ['system', 'id', ['rec_1']],
    ['err-empty', 'title', []],
    ['err-too-many', 'title', Array.from({ length: 201 }, (_, i) => `k${i}`)],
    ['err-unknown', 'nope', ['a']],
];

/**
 * Role x action combinations the row rules produce, compiled through the real
 * compileAccessFilter and then into a list, an aggregate and a get-by-id.
 * [name, role, viewer, action]
 */
const ACCESS_CASES = [
    ['owner', 'owner', { id: 'u_owner' }, 'read'],
    ['editor-read', 'editor', { id: 'u_ed' }, 'read'],
    ['viewer-own', 'viewer', { id: 'u_v' }, 'read'],
    ['viewer-no-id', 'viewer', {}, 'read'],
    ['viewer-update-none', 'viewer', { id: 'u_v' }, 'update'],
    ['regional-row-filter', 'regional', { id: 'u_r', region: 'eu' }, 'read'],
    ['regional-row-filter-missing-attr', 'regional', { id: 'u_r' }, 'read'],
    ['regional-update-own', 'regional', { id: 'u_r', region: 'eu' }, 'update'],
    ['ownregional-complex', 'ownregional', { id: 'u_o' }, 'read'],
    ['ownregional-delete', 'ownregional', { id: 'u_o' }, 'delete'],
    ['public', 'public', null, 'read'],
    ['unknown-role', 'stranger', { id: 'u_s' }, 'read'],
    ['null-role', null, { id: 'u_n' }, 'read'],
];

/** The list descriptor every access case is compiled with. */
const ACCESS_LIST_OPTS = { filters: [{ field: 'title', op: 'contains', value: 'a' }], sort: [{ field: 'amount', dir: 'asc' }], limit: 10 };
/** The aggregate descriptor every access case is compiled with. */
const ACCESS_AGG_OPTS = { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }, { fn: 'p50', field: 'amount', as: 'median' }] };

/** The clampLimit inputs: [limit, max?]. */
const CLAMP_CASES = [[undefined], [''], [-5], ['abc'], [NaN], [0], [1], [49.9], ['77'], [5000], [100, 10], [100, 0], [100, 5000], [3, 2.7]];

module.exports = {
    TABLE, ACCESS, ALLOW, cursorOf,
    LIST_CASES, AGGREGATE_CASES, GET_BY_ID_CASES, KEY_INDEX_CASES,
    ACCESS_CASES, ACCESS_LIST_OPTS, ACCESS_AGG_OPTS, CLAMP_CASES,
};
