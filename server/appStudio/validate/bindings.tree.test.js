// @typecheck
'use strict';

/**
 * Filter trees ({ all } / { any } / { not } to depth 3), column comparisons
 * ({ field, op, otherField }) and orderBy in a record / records / aggregate
 * binding: what the validator accepts and refuses, and that the canonicalizer
 * keeps them.
 *
 * Run: node --test appStudio/validate/bindings.tree.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateBinding } = require('./bindings');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { MAX_ORDER_BY } = require('../componentSpecs');
const queryCompiler = require('../../core/dataEngine/queryCompiler');

function findings(binding) {
    /** @type {any[]} */
    const errors = [];
    const ctx = {
        pushE: (/** @type {any} */ r) => errors.push(r), pushW: () => {},
        actionIds: new Set(),
        dataTables: new Map([['tbl_t', new Set(['status', 'priority', 'spent', 'budget'])]]),
    };
    validateBinding('source', binding, 'p', ctx);
    return errors.map((e) => `${e.code}@${e.path}`);
}
const records = (/** @type {unknown} */ filter, extra = {}) => findings({ kind: 'records', tableId: 'tbl_t', filter, ...extra });
const OPEN = { field: 'status', op: 'eq', value: 'open' };
const HIGH = { field: 'priority', op: 'eq', value: { kind: 'formula', expr: 'vars.p' } };
const OVER = { field: 'spent', op: 'gt', otherField: 'budget' };

test('all, not and nested groups validate clean to depth 3, on every data binding kind', () => {
    assert.deepStrictEqual(records([{ all: [OPEN, HIGH] }]), []);
    assert.deepStrictEqual(records([{ not: OPEN }, { not: { any: [OPEN, HIGH] }, required: true }]), []);
    assert.deepStrictEqual(records([{ any: [{ all: [OPEN, { not: HIGH }] }, OVER] }]), []);
    assert.deepStrictEqual(findings({ kind: 'record', tableId: 'tbl_t', filter: [{ all: [OPEN] }] }), []);
    assert.deepStrictEqual(findings({ kind: 'aggregate', tableId: 'tbl_t', filter: [{ not: OVER }], aggregates: [{ fn: 'count', as: 'n' }] }), []);
});

test('clauses inside a tree are checked at their own path', () => {
    assert.deepStrictEqual(records([{ any: [{ all: [OPEN, { not: { field: 'nope', op: 'eq', value: 1 } }] }] }]),
        ['binding.unknown_field@p.filter[0].any[0].all[1].not.field']);
    assert.deepStrictEqual(records([{ not: { all: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: '1 +' } }] } }]),
        ['formula.parse_error@p.filter[0].not.all[0].value.expr']);
});

test('a fourth level, an empty all, a list under not and an any directly in an any are refused', () => {
    assert.deepStrictEqual(records([{ any: [{ all: [{ not: { all: [OPEN] } }] }] }]), ['binding.filter_too_deep@p.filter[0].any[0].all[0].not']);
    assert.deepStrictEqual(records([{ all: [] }]), ['binding.filter_group_empty@p.filter[0].all']);
    assert.deepStrictEqual(records([{ not: [OPEN] }]), ['binding.filter_group_empty@p.filter[0].not']);
    assert.deepStrictEqual(records([{ all: [OPEN], op: 'eq' }]), ['binding.filter_invalid@p.filter[0]']);
    assert.deepStrictEqual(records([{ all: [{ any: [OPEN, { any: [HIGH] }] }] }]), ['binding.filter_group_nested@p.filter[0].all[0].any[1]']);
    assert.deepStrictEqual(records([{ not: OPEN, required: 'yes' }]), ['binding.filter_invalid@p.filter[0].required']);
});

test('otherField: a field of the table, a comparison op, no value', () => {
    assert.deepStrictEqual(records([OVER, { field: 'status', op: 'neq', otherField: 'created_by' }]), []);
    assert.deepStrictEqual(records([{ field: 'spent', op: 'gt', otherField: 'nope' }]), ['binding.unknown_field@p.filter[0].otherField']);
    assert.deepStrictEqual(records([{ field: 'spent', op: 'contains', otherField: 'budget' }]), ['binding.filter_invalid@p.filter[0].op']);
    assert.deepStrictEqual(records([{ field: 'spent', op: 'gt', otherField: 'budget', value: 3 }]), ['binding.filter_invalid@p.filter[0].value']);
    assert.deepStrictEqual(records([{ field: 'spent', op: 'gt', otherField: 7 }]), ['binding.filter_invalid@p.filter[0].otherField']);
});

test('orderBy: 1 to 3 entries, each field once, not next to sort', () => {
    const by = (/** @type {unknown} */ orderBy, extra = {}) => records(undefined, { orderBy, ...extra });
    assert.deepStrictEqual(by([{ field: 'status', dir: 'asc' }, { field: 'spent', dir: 'desc' }, { field: 'created_at' }]), []);
    assert.deepStrictEqual(by([]), ['binding.sort_invalid@p.orderBy']);
    assert.deepStrictEqual(by({ field: 'status' }), ['binding.sort_invalid@p.orderBy']);
    assert.deepStrictEqual(by([{ field: 'status' }, { field: 'spent' }, { field: 'budget' }, { field: 'priority' }]), ['binding.sort_invalid@p.orderBy']);
    assert.deepStrictEqual(by([{ field: 'status' }, { field: 'status', dir: 'asc' }]), ['binding.sort_invalid@p.orderBy[1].field']);
    assert.deepStrictEqual(by([{ field: 'nope' }]), ['binding.unknown_field@p.orderBy[0].field']);
    assert.deepStrictEqual(by([{ field: 'status', dir: 'up' }]), ['binding.sort_invalid@p.orderBy[0].dir']);
    assert.deepStrictEqual(by([{ field: 'status' }], { sort: [{ field: 'spent' }] }), ['binding.sort_invalid@p.orderBy']);
});

test('orderBy on an aggregate names its output columns; a dynamic shape is checked when it runs', () => {
    const agg = (/** @type {Record<string, unknown>} */ extra) => findings({ kind: 'aggregate', tableId: 'tbl_t', groupBy: [{ field: 'status' }], aggregates: [{ fn: 'count', as: 'n' }], ...extra });
    assert.deepStrictEqual(agg({ orderBy: [{ field: 'n', dir: 'desc' }, { field: 'status', dir: 'asc' }] }), []);
    assert.deepStrictEqual(agg({ orderBy: [{ field: 'spent' }] }), ['binding.sort_invalid@p.orderBy[0].field']);
    assert.deepStrictEqual(agg({ groupBy: { kind: 'formula', expr: 'vars.g' }, orderBy: [{ field: 'spent' }] }), []);
});

test('the orderBy limit: the spec and the compiler agree', () => {
    assert.strictEqual(MAX_ORDER_BY, queryCompiler.MAX_ORDER_BY);
});

test('canonicalize keeps a tree, an otherField and an orderBy; a binding without them gains nothing', () => {
    const source = { kind: 'records', tableId: 'tbl_t', filter: [{ any: [{ all: [OPEN, { not: HIGH }] }, OVER] }], orderBy: [{ field: 'status', dir: 'asc' }, { field: 'spent', dir: 'desc' }] };
    const plain = { kind: 'records', tableId: 'tbl_t', filter: [OPEN], sort: [{ field: 'status', dir: 'asc' }] };
    const def = (/** @type {unknown} */ binding) => ({
        schemaVersion: 2, name: 'T',
        screens: [{ id: 'scr_aaaaaa', name: 'S', sections: [{ id: 'sec_aaaaaa', children: [{ id: 'cmp_aaaaaa', type: 'table', props: { columns: [], source: binding } }] }] }],
    });
    const out = (/** @type {unknown} */ binding) => canonicalizeAppDefinition(def(binding)).def.screens[0].sections[0].children[0].props.source;
    assert.deepStrictEqual(out(source), source);
    assert.deepStrictEqual(out(plain), plain);
    assert.strictEqual('orderBy' in out(plain), false);
});
