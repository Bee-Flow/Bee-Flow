// @typecheck strict
/**
 * Aggregate descriptors of the vocabulary after schema version 2, pinned by
 * queryCompiler.snapshot.test.js in their own sections (`aggregateExtended`,
 * `aggregateRelated`): countDistinct, binWidth, groupFilter and groupBy through
 * a relation. Kept apart from queryCompiler.snapshot.fixture.js so the cases
 * that were there before stay exactly as they were.
 *
 * Re-capture after ADDING a case:
 *   UPDATE_GOLDEN=1 node --test core/dataEngine/queryCompiler.snapshot.test.js
 */

'use strict';

/**
 * [name, opts] over the base fixture table (`tasks`). No relation map is handed
 * over here, so a relatedField case must be refused.
 * @type {Array<[string, Record<string, unknown>]>}
 */
const EXTENDED_CASES = [
    ['count-distinct', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'countDistinct', field: 'created_by', as: 'people' }] }],
    ['count-distinct-default-alias', { aggregates: [{ fn: 'countDistinct', field: 'region' }] }],
    ['count-distinct-percentile', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'countDistinct', field: 'title', as: 'titles' }, { fn: 'p50', field: 'amount', as: 'm' }] }],
    ['bin', { groupBy: [{ field: 'amount', binWidth: 10 }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['bin-as-sorted', { groupBy: [{ field: 'amount', binWidth: 250, as: 'band' }], aggregates: [{ fn: 'count', as: 'n' }], sort: [{ field: 'band', dir: 'asc' }] }],
    ['bin-percentile', { groupBy: [{ field: 'amount', binWidth: 100, as: 'band' }], aggregates: [{ fn: 'p90', field: 'amount', as: 'p' }] }],
    ['group-filter', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }, { fn: 'sum', field: 'amount', as: 'total' }], groupFilter: [{ field: 'n', op: 'gte', value: 3 }, { field: 'total', op: 'lt', value: 1000.5 }] }],
    ['group-filter-every-op', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], groupFilter: ['eq', 'neq', 'gt', 'gte', 'lt'].map((op, i) => ({ field: 'n', op, value: i })) }],
    ['group-filter-ungrouped', { aggregates: [{ fn: 'avg', field: 'amount', as: 'mean' }], groupFilter: [{ field: 'mean', op: 'lte', value: 0 }] }],
    ['group-filter-percentile', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'p50', field: 'amount', as: 'm' }, { fn: 'count', as: 'n' }], groupFilter: [{ field: 'm', op: 'gt', value: 10 }, { field: 'n', op: 'gt', value: 1 }] }],
    ['group-filter-count-distinct-order-by', {
        filters: [{ field: 'done', op: 'eq', value: false }],
        groupBy: [{ field: 'region' }],
        aggregates: [{ fn: 'countDistinct', field: 'created_by', as: 'people' }],
        groupFilter: [{ field: 'people', op: 'gt', value: 1 }],
        orderBy: [{ field: 'people', dir: 'desc' }],
        limit: 5,
    }],
    ['group-filter-null-ignored', { aggregates: [{ fn: 'count', as: 'n' }], groupFilter: null }],
    // Invalid descriptors.
    ['err-count-distinct-no-field', { aggregates: [{ fn: 'countDistinct' }] }],
    ['err-count-distinct-star', { aggregates: [{ fn: 'countDistinct', field: '*' }] }],
    ['err-count-distinct-computed', { aggregates: [{ fn: 'countDistinct', field: 'total' }] }],
    ['err-bin-text', { groupBy: [{ field: 'region', binWidth: 10 }] }],
    ['err-bin-zero', { groupBy: [{ field: 'amount', binWidth: 0 }] }],
    ['err-bin-fraction', { groupBy: [{ field: 'amount', binWidth: 2.5 }] }],
    ['err-bin-string', { groupBy: [{ field: 'amount', binWidth: '10' }] }],
    ['err-bin-huge', { groupBy: [{ field: 'amount', binWidth: 1e10 }] }],
    ['err-bin-and-bucket', { groupBy: [{ field: 'due', bucket: 'month', binWidth: 10 }] }],
    ['err-bin-untyped-computed', { groupBy: [{ field: 'stored_total', binWidth: 5 }] }],
    ['err-bin-system-column', { groupBy: [{ field: 'created_at', binWidth: 10 }] }],
    ['err-group-filter-group-alias', { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], groupFilter: [{ field: 'region', op: 'eq', value: 1 }] }],
    ['err-group-filter-unknown', { aggregates: [{ fn: 'count', as: 'n' }], groupFilter: [{ field: 'nope', op: 'gt', value: 1 }] }],
    ['err-group-filter-text-aggregate', { aggregates: [{ fn: 'max', field: 'due', as: 'last' }], groupFilter: [{ field: 'last', op: 'gt', value: 1 }] }],
    ['err-group-filter-op', { aggregates: [{ fn: 'count', as: 'n' }], groupFilter: [{ field: 'n', op: 'contains', value: 1 }] }],
    ['err-group-filter-string-value', { aggregates: [{ fn: 'count', as: 'n' }], groupFilter: [{ field: 'n', op: 'gt', value: '1' }] }],
    ['err-group-filter-empty', { aggregates: [{ fn: 'count', as: 'n' }], groupFilter: [] }],
    ['err-group-filter-object', { aggregates: [{ fn: 'count', as: 'n' }], groupFilter: { field: 'n', op: 'gt', value: 1 } }],
    ['err-group-filter-too-many', { aggregates: [{ fn: 'count', as: 'n' }], groupFilter: Array.from({ length: 6 }, () => ({ field: 'n', op: 'gt', value: 1 })) }],
    ['err-related-no-map', { groupBy: [{ field: 'owner_ref', relatedField: 'name' }] }],
    ['err-related-not-relation', { groupBy: [{ field: 'region', relatedField: 'name' }] }],
];

/** The table a relation points at. */
const CUSTOMERS = {
    id: 'tbl_cust01',
    key: 'customers',
    fields: [
        { id: 'fld_c1', key: 'name', type: 'text' },
        { id: 'fld_c2', key: 'segment', type: 'text' },
        { id: 'fld_c3', key: 'staff', type: 'number' },
        { id: 'fld_c4', key: 'since', type: 'date' },
        { id: 'fld_c5', key: 'score', type: 'computed', computed: { expr: 'staff * 2' } },
    ],
};

/** The aggregated table: two relations to customers and one to itself. */
const ORDERS = {
    id: 'tbl_ord01',
    key: 'orders',
    fields: [
        { id: 'fld_o1', key: 'amount', type: 'number' },
        { id: 'fld_o2', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01' } },
        { id: 'fld_o3', key: 'billed_to', type: 'relation', relation: { table: 'tbl_cust01' } },
        { id: 'fld_o4', key: 'parent', type: 'relation', relation: { table: 'tbl_ord01' } },
        { id: 'fld_o5', key: 'stray', type: 'relation', relation: { table: 'tbl_gone01' } },
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

/**
 * [name, opts, related?] over ORDERS with ORDERS_ACCESS. `related` defaults to RELATED.
 * @type {Array<[string, Record<string, unknown>, unknown?]>}
 */
const RELATED_CASES = [
    ['related', { groupBy: [{ field: 'customer', relatedField: 'segment' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] }],
    ['related-as-and-filters', { filters: [{ field: 'amount', op: 'gt', value: 5 }], groupBy: [{ field: 'customer', relatedField: 'name', as: 'who' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['related-bucket', { groupBy: [{ field: 'customer', relatedField: 'since', bucket: 'year' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['related-bin', { groupBy: [{ field: 'customer', relatedField: 'staff', binWidth: 50 }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['related-system-column', { groupBy: [{ field: 'customer', relatedField: 'created_by' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['related-two-and-plain', { groupBy: [{ field: 'customer', relatedField: 'segment' }, { field: 'billed_to', relatedField: 'segment', as: 'billed' }, { field: 'amount' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['related-self', { groupBy: [{ field: 'parent', relatedField: 'amount', as: 'parent_amount' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    ['related-percentile', { groupBy: [{ field: 'customer', relatedField: 'segment' }], aggregates: [{ fn: 'p50', field: 'amount', as: 'm' }] }],
    ['related-group-filter-order-by', {
        groupBy: [{ field: 'customer', relatedField: 'segment', as: 'seg' }],
        aggregates: [{ fn: 'countDistinct', field: 'customer', as: 'buyers' }, { fn: 'sum', field: 'amount', as: 'total' }],
        groupFilter: [{ field: 'total', op: 'gt', value: 100 }],
        orderBy: [{ field: 'total', dir: 'desc' }, { field: 'seg', dir: 'asc' }],
        limit: 20,
    }],
    ['related-map-unused', { groupBy: [{ field: 'customer' }], aggregates: [{ fn: 'count', as: 'n' }] }],
    // Invalid descriptors.
    ['err-related-wrong-target', { groupBy: [{ field: 'stray', relatedField: 'segment' }] }],
    ['err-related-unknown-field', { groupBy: [{ field: 'customer', relatedField: 'nope' }] }],
    ['err-related-computed', { groupBy: [{ field: 'customer', relatedField: 'score' }] }],
    ['err-related-empty', { groupBy: [{ field: 'customer', relatedField: '' }] }],
    ['err-related-bin-text', { groupBy: [{ field: 'customer', relatedField: 'segment', binWidth: 10 }] }],
    ['err-related-too-many', { groupBy: Array.from({ length: 4 }, (_, i) => ({ field: 'customer', relatedField: 'segment', as: `s${i}` })) }],
    ['err-related-missing-entry', { groupBy: [{ field: 'customer', relatedField: 'segment' }] }, { parent: RELATED.parent }],
    ['err-related-unscoped', { groupBy: [{ field: 'customer', relatedField: 'segment' }] }, { customer: { tableMeta: CUSTOMERS, accessFilter: null } }],
    ['err-related-bad-table', { groupBy: [{ field: 'customer', relatedField: 'segment' }] }, { customer: { tableMeta: { id: 'tbl_cust01', key: 'Bad Key' }, accessFilter: CUSTOMERS_ACCESS } }],
];

module.exports = { EXTENDED_CASES, RELATED_CASES, ORDERS, ORDERS_ACCESS, CUSTOMERS, CUSTOMERS_ACCESS, RELATED };
