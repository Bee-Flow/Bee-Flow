// @typecheck
'use strict';

/**
 * countDistinct, groupBy binWidth / relatedField and groupFilter on an
 * aggregate binding: what the validator accepts and refuses (against a real
 * data model through validateAppDefinition), and that the canonicalizer keeps
 * them while a binding without them gains nothing.
 *
 * Run: node --test appStudio/validate/aggregateChecks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { groupByAlias } = require('./aggregateChecks.mts');

const MODEL = {
    tables: [
        {
            id: 'tbl_ord01', key: 'orders', name: 'Orders',
            fields: [
                { id: 'fld_o1', key: 'amount', type: 'number' },
                { id: 'fld_o2', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01' } },
                { id: 'fld_o3', key: 'channel', type: 'text' },
                { id: 'fld_o4', key: 'feed', type: 'relation', relation: { table: 'tbl_link01' } },
            ],
        },
        {
            id: 'tbl_cust01', key: 'customers', name: 'Customers',
            fields: [{ id: 'fld_c1', key: 'region', type: 'text' }, { id: 'fld_c2', key: 'staff', type: 'number' }],
        },
        { id: 'tbl_link01', key: 'feed', name: 'Feed', source: { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' }, fields: [{ id: 'fld_l1', key: 'label', type: 'text' }] },
    ],
};

const defWith = (/** @type {unknown} */ source) => ({
    schemaVersion: 2, name: 'T',
    screens: [{ id: 'scr_aaaaaa', name: 'S', sections: [{ id: 'sec_aaaaaa', children: [{ id: 'cmp_aaaaaa', type: 'chart', props: { source } }] }] }],
});

/** The aggregate-binding findings of a chart bound to `extra` over orders. */
function findings(/** @type {Record<string, unknown>} */ extra) {
    const source = { kind: 'aggregate', tableId: 'tbl_ord01', aggregates: [{ fn: 'count', as: 'n' }], ...extra };
    const { errors } = validateAppDefinition(defWith(source), { dataModel: MODEL, datatables: ['tbl_dt0001'] });
    return errors.filter((e) => e.path.includes('.source')).map((e) => `${e.code}@${e.path.slice(e.path.indexOf('source'))}`);
}

test('the new vocabulary validates clean when it is used right', () => {
    assert.deepStrictEqual(findings({ aggregates: [{ fn: 'countDistinct', field: 'customer', as: 'buyers' }] }), []);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'amount', binWidth: 50 }] }), []);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'customer', relatedField: 'region' }] }), []);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'customer', relatedField: 'staff', binWidth: 10, as: 'size' }], orderBy: [{ field: 'size' }] }), []);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'channel' }], groupFilter: [{ field: 'n', op: 'gte', value: 3 }] }), []);
    assert.deepStrictEqual(findings({ aggregates: { kind: 'formula', expr: 'vars.a' }, groupFilter: [{ field: 'whatever', op: 'gt', value: 1 }] }), []);
});

test('the derived output column names match the compiler, so orderBy and pick may name them', () => {
    assert.strictEqual(groupByAlias({ field: 'amount', binWidth: 50 }), 'amount_bin');
    assert.strictEqual(groupByAlias({ field: 'customer', relatedField: 'region' }), 'customer_region');
    assert.strictEqual(groupByAlias({ field: 'customer', relatedField: 'since', bucket: 'year' }), 'customer_since_year');
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'customer', relatedField: 'region' }], orderBy: [{ field: 'customer_region' }] }), []);
});

test('countDistinct needs a field', () => {
    assert.deepStrictEqual(findings({ aggregates: [{ fn: 'countDistinct' }] }), ['binding.aggregate_invalid@source.aggregates[0].field']);
});

test('binWidth: a whole number on a number column, never with a date bucket', () => {
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'amount', binWidth: 2.5 }] }), ['binding.aggregate_invalid@source.groupBy[0].binWidth']);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'channel', binWidth: 10 }] }), ['binding.aggregate_invalid@source.groupBy[0].binWidth']);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'customer', relatedField: 'region', binWidth: 10 }] }), ['binding.aggregate_invalid@source.groupBy[0].binWidth']);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'amount', binWidth: 10, bucket: 'day' }] }), ['binding.aggregate_invalid@source.groupBy[0].binWidth']);
});

test('relatedField: a relation of this app to a table with its own storage, and a column there', () => {
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'channel', relatedField: 'region' }] }), ['binding.aggregate_invalid@source.groupBy[0].field']);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'customer', relatedField: 'nope' }] }), ['binding.unknown_field@source.groupBy[0].relatedField']);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'customer', relatedField: '' }] }), ['binding.aggregate_invalid@source.groupBy[0].relatedField']);
    assert.deepStrictEqual(findings({ groupBy: [{ field: 'feed', relatedField: 'label' }] }), ['binding.aggregate_invalid@source.groupBy[0].relatedField']);
    const four = Array.from({ length: 4 }, (_, i) => ({ field: 'customer', relatedField: 'region', as: `r${i}` }));
    assert.deepStrictEqual(findings({ groupBy: four }), ['binding.aggregate_invalid@source.groupBy[3]']);
});

test('groupFilter names a number aggregate of the binding, with a known op and a number', () => {
    assert.deepStrictEqual(findings({ groupFilter: [] }), ['binding.aggregate_invalid@source.groupFilter']);
    assert.deepStrictEqual(findings({ groupFilter: [{ field: 'channel', op: 'gt', value: 1 }] }), ['binding.aggregate_invalid@source.groupFilter[0].field']);
    assert.deepStrictEqual(findings({ groupFilter: [{ field: 'n', op: 'like', value: '1' }] }),
        ['binding.aggregate_invalid@source.groupFilter[0].op', 'binding.aggregate_invalid@source.groupFilter[0].value']);
    assert.deepStrictEqual(findings({ aggregates: [{ fn: 'max', field: 'channel', as: 'last' }], groupFilter: [{ field: 'last', op: 'gt', value: 1 }] }),
        ['binding.aggregate_invalid@source.groupFilter[0].field']);
    assert.deepStrictEqual(findings({ aggregates: [{ fn: 'max', field: 'amount', as: 'top' }], groupFilter: [{ field: 'top', op: 'gt', value: 1 }] }), []);
});

test('canonicalize keeps the new vocabulary; an aggregate without it gains nothing', () => {
    const source = {
        kind: 'aggregate', tableId: 'tbl_ord01',
        groupBy: [{ field: 'customer', relatedField: 'staff', binWidth: 10, as: 'size' }],
        aggregates: [{ fn: 'countDistinct', field: 'customer', as: 'buyers' }],
        groupFilter: [{ field: 'buyers', op: 'gt', value: 1 }],
    };
    const plain = { kind: 'aggregate', tableId: 'tbl_ord01', groupBy: [{ field: 'channel', bucket: 'day' }], aggregates: [{ fn: 'count', as: 'n' }] };
    const out = (/** @type {unknown} */ s) => canonicalizeAppDefinition(defWith(s)).def.screens[0].sections[0].children[0].props.source;
    assert.deepStrictEqual(out(source), source);
    assert.deepStrictEqual(out(plain), plain);
    assert.deepStrictEqual(Object.keys(out(plain)), ['kind', 'tableId', 'groupBy', 'aggregates']);
});
