// @typecheck strict
/**
 * Record reads through a relation and with a column list, pinned by
 * queryCompiler.snapshot.test.js in their own sections (`listRelation`,
 * `aggregateRelationFilter`): expand, fields, and `<relation>.<column>`
 * filters. Kept apart from the other fixtures so the cases that were there
 * before stay exactly as they were.
 *
 * Re-capture after ADDING a case:
 *   UPDATE_GOLDEN=1 node --test core/dataEngine/queryCompiler.snapshot.test.js
 */

'use strict';

const CUSTOMERS = {
    id: 'tbl_cust01',
    key: 'customers',
    fields: [
        { id: 'fld_c1', key: 'name', type: 'text' },
        { id: 'fld_c2', key: 'segment', type: 'text' },
        { id: 'fld_c3', key: 'staff', type: 'number' },
        { id: 'fld_c4', key: 'vip', type: 'bool' },
        { id: 'fld_c5', key: 'score', type: 'computed', computed: { expr: 'staff * 2' } },
    ],
};

/** The listed table: two relations to customers (one with a display field), one to itself, one dangling. */
const ORDERS = {
    id: 'tbl_ord01',
    key: 'orders',
    fields: [
        { id: 'fld_o1', key: 'amount', type: 'number' },
        { id: 'fld_o2', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01', displayField: 'name' } },
        { id: 'fld_o3', key: 'billed_to', type: 'relation', relation: { table: 'tbl_cust01' } },
        { id: 'fld_o4', key: 'parent', type: 'relation', relation: { table: 'tbl_ord01', displayField: 'nope' } },
        { id: 'fld_o5', key: 'stray', type: 'relation', relation: { table: 'tbl_gone01' } },
        { id: 'fld_o6', key: 'status', type: 'text' },
        { id: 'fld_o7', key: 'customer_record', type: 'text' },
        { id: 'fld_o8', key: 'margin', type: 'computed', computed: { expr: 'amount * 0.2' } },
    ],
};

const ORDERS_ACCESS = { where: '"created_by" = ?', params: ['viewer-1'] };
/** A row rule on the related table, with a bound viewer value. */
const CUSTOMERS_ACCESS = { where: '(1=1) AND (("segment" = ?))', params: ['retail'] };

const RELATED = {
    customer: { tableMeta: CUSTOMERS, accessFilter: CUSTOMERS_ACCESS },
    billed_to: { tableMeta: CUSTOMERS, accessFilter: { where: '1=0', params: [] } },
    parent: { tableMeta: ORDERS, accessFilter: ORDERS_ACCESS },
    stray: { tableMeta: CUSTOMERS, accessFilter: CUSTOMERS_ACCESS },
};

/** The cursor after a row of an orderBy [status, amount] read. */
const ORDER_CURSOR = require('./queryCompiler').nextCursor({ primaryField: 'status', orderFields: ['status', 'amount', 'id'] }, { status: 'open', amount: 5, id: 'r9' });

const AS = (/** @type {string} */ field, /** @type {Record<string, unknown>} */ extra = {}) => ({ field, as: `${field}_row`, ...extra });
const R = (/** @type {string} */ field, /** @type {string} */ op, /** @type {unknown} */ value) => ({ field, op, value });

/**
 * [name, opts, read] over ORDERS with ORDERS_ACCESS. `read.related` defaults to RELATED.
 * @type {Array<[string, Record<string, unknown>, Record<string, unknown>]>}
 */
const LIST_CASES = [
    // expand: the list itself is unchanged; the lookups are separate queries.
    ['expand-pick', {}, { expand: [AS('customer', { pick: ['name', 'segment'] })] }],
    ['expand-display-field', {}, { expand: [AS('customer')] }],
    ['expand-no-display-field', {}, { expand: [{ field: 'billed_to' }] }],
    ['expand-display-field-unknown', {}, { expand: [{ field: 'parent', pick: ['amount', 'created_at'] }] }],
    ['expand-two-and-self', { filters: [R('amount', 'gt', 5)], limit: 10 }, { expand: [AS('customer', { pick: ['name'] }), { field: 'billed_to', pick: ['name'] }, { field: 'parent', pick: ['amount', 'status'] }] }],
    ['expand-pick-repeats', {}, { expand: [AS('customer', { pick: ['name', 'name', 'id'] })] }],
    // fields: the select list.
    ['fields', {}, { fields: ['status', 'amount'] }],
    ['fields-repeat-id-system', {}, { fields: ['id', 'status', 'status', 'created_at'] }],
    ['fields-sort-outside', { sort: [{ field: 'amount', dir: 'asc' }] }, { fields: ['status'] }],
    ['fields-order-by-cursor', { orderBy: [{ field: 'status' }, { field: 'amount', dir: 'asc' }], cursor: ORDER_CURSOR }, { fields: ['status'] }],
    // No column is selected for it; the record keeps its value when the read evaluates it (readTimeComputed).
    ['fields-read-time-computed-not-selected', {}, { fields: ['status', 'margin'] }],
    ['fields-and-expand', {}, { fields: ['status'], expand: [AS('customer', { pick: ['name'] })] }],
    ['fields-with-relation-listed', {}, { fields: ['customer', 'status'], expand: [AS('customer')] }],
    // filters through a relation.
    ['filter', { filters: [R('customer.segment', 'eq', 'retail')] }, {}],
    ['filter-with-plain', { filters: [R('status', 'eq', 'open'), R('customer.staff', 'gte', 10)] }, {}],
    ['filter-bool-in-like', { filters: [R('customer.vip', 'eq', true), R('customer.segment', 'in', ['a', 'b']), R('customer.name', 'contains', '50%')] }, {}],
    ['filter-ci', { filters: [{ field: 'customer.name', op: 'eq', value: 'acme', ci: true }] }, {}],
    ['filter-null-ops', { filters: [R('customer.segment', 'isNull', undefined), R('customer.segment', 'notIn', ['x'])] }, {}],
    ['filter-system-column', { filters: [R('customer.created_by', 'eq', 'u9')] }, {}],
    ['filter-in-groups', { filters: [{ any: [R('customer.segment', 'eq', 'a'), { all: [R('status', 'eq', 'open'), { not: R('billed_to.segment', 'eq', 'b') }] }] }] }, {}],
    ['filter-match-any-search', { match: 'any', filters: [R('customer.segment', 'eq', 'a'), R('amount', 'lt', 3)], search: { value: 'q', fields: ['status'] } }, {}],
    ['filter-self', { filters: [R('parent.status', 'eq', 'open')] }, {}],
    ['filter-unreadable-target', { filters: [R('billed_to.name', 'eq', 'x')] }, {}],
    ['filter-expand-fields', { filters: [R('customer.segment', 'neq', 'x')], sort: [{ field: 'amount' }] }, { fields: ['status'], expand: [AS('customer', { pick: ['name'] })] }],
    ['read-empty', { filters: [R('status', 'eq', 'open')] }, {}],
    // Invalid reads.
    ['err-expand-not-list', {}, { expand: { field: 'customer' } }],
    ['err-expand-empty', {}, { expand: [] }],
    ['err-expand-too-many', {}, { expand: Array.from({ length: 6 }, (_, i) => ({ field: 'customer', as: `c${i}` })) }],
    ['err-expand-entry', {}, { expand: ['customer'] }],
    ['err-expand-unknown-field', {}, { expand: [{ field: 'nope' }] }],
    ['err-expand-not-relation', {}, { expand: [{ field: 'status' }] }],
    ['err-expand-nested', {}, { expand: [AS('customer', { expand: [{ field: 'x' }] })] }],
    ['err-expand-default-alias-taken', {}, { expand: [{ field: 'customer' }] }],
    ['err-expand-alias-is-column', {}, { expand: [{ field: 'customer', as: 'status' }] }],
    ['err-expand-alias-is-system-column', {}, { expand: [{ field: 'customer', as: 'created_at' }] }],
    ['err-expand-alias-invalid', {}, { expand: [{ field: 'customer', as: 'a b' }] }],
    ['err-expand-alias-twice', {}, { expand: [AS('customer'), { field: 'billed_to', as: 'customer_row' }] }],
    ['err-expand-pick-empty', {}, { expand: [AS('customer', { pick: [] })] }],
    ['err-expand-pick-too-many', {}, { expand: [AS('customer', { pick: Array.from({ length: 21 }, () => 'name') })] }],
    ['err-expand-pick-unknown', {}, { expand: [AS('customer', { pick: ['ssn'] })] }],
    ['err-expand-pick-computed', {}, { expand: [AS('customer', { pick: ['score'] })] }],
    ['err-expand-wrong-target', {}, { expand: [{ field: 'stray' }] }],
    ['err-expand-no-related-entry', {}, { expand: [AS('customer')], related: { parent: RELATED.parent } }],
    ['err-expand-unscoped', {}, { expand: [AS('customer')], related: { customer: { tableMeta: CUSTOMERS, accessFilter: null } } }],
    ['err-fields-not-list', {}, { fields: 'status' }],
    ['err-fields-empty', {}, { fields: [] }],
    ['err-fields-unknown', {}, { fields: ['status', 'ssn'] }],
    ['err-fields-dotted', {}, { fields: ['customer.name'] }],
    ['err-fields-too-many', {}, { fields: Array.from({ length: 101 }, () => 'status') }],
    ['err-filter-too-deep', { filters: [R('customer.parent.name', 'eq', 'x')] }, {}],
    ['err-filter-empty-column', { filters: [R('customer.', 'eq', 'x')] }, {}],
    ['err-filter-not-relation', { filters: [R('status.name', 'eq', 'x')] }, {}],
    ['err-filter-unknown-relation', { filters: [R('nope.name', 'eq', 'x')] }, {}],
    ['err-filter-unknown-column', { filters: [R('customer.ssn', 'eq', 'x')] }, {}],
    ['err-filter-computed-column', { filters: [R('customer.score', 'gt', 1)] }, {}],
    ['err-filter-other-field', { filters: [{ field: 'customer.staff', op: 'gt', otherField: 'amount' }] }, {}],
    ['err-filter-other-field-dotted', { filters: [{ field: 'amount', op: 'gt', otherField: 'customer.staff' }] }, {}],
    ['err-filter-op', { filters: [R('customer.name', 'like', 'x')] }, {}],
    ['err-filter-wrong-target', { filters: [R('stray.segment', 'eq', 'x')] }, {}],
    ['err-filter-no-related-entry', { filters: [R('customer.segment', 'eq', 'x')] }, { related: {} }],
    ['err-filter-too-many', { filters: Array.from({ length: 6 }, (_, i) => R('customer.staff', 'gt', i)) }, {}],
    ['err-search-dotted', { search: { value: 'x', fields: ['customer.name'] } }, {}],
    ['err-sort-dotted', { sort: [{ field: 'customer.name' }] }, {}],
];

/**
 * Without a `read` argument a dotted name is what it always was: an unknown field.
 * @type {Array<[string, Record<string, unknown>]>}
 */
const NO_READ_CASES = [
    ['dotted-filter-unknown-field', { filters: [R('customer.segment', 'eq', 'x')] }],
];

/**
 * [name, opts] aggregates over ORDERS with RELATED: a filter through a relation, alone and next to a related groupBy.
 * @type {Array<[string, Record<string, unknown>]>}
 */
const AGGREGATE_CASES = [
    ['filter', { filters: [R('customer.segment', 'eq', 'retail')], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['filter-and-related-group', { filters: [R('billed_to.segment', 'eq', 'x'), R('amount', 'gt', 1)], groupBy: [{ field: 'customer', relatedField: 'segment' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }], groupFilter: [{ field: 'total', op: 'gt', value: 10 }] }],
    ['filter-percentile', { filters: [R('customer.staff', 'lt', 50)], groupBy: [{ field: 'status' }], aggregates: [{ fn: 'p50', field: 'amount', as: 'm' }] }],
    ['err-filter-unknown-column', { filters: [R('customer.ssn', 'eq', 1)], aggregates: [{ fn: 'count', as: 'n' }] }],
];

module.exports = { LIST_CASES, NO_READ_CASES, AGGREGATE_CASES, ORDERS, ORDERS_ACCESS, CUSTOMERS, CUSTOMERS_ACCESS, RELATED };
