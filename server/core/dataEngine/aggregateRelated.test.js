/**
 * relatedForAggregate: the related table of a groupBy through a relation, with
 * the VIEWER's access predicate on it (1=0 for a role that may not read it);
 * only relation fields to tables of the same app with their own storage are
 * followed, and a descriptor without relatedField gets nothing (so it compiles
 * as before). Plus the keys that only grow when the new vocabulary is used.
 *
 * Run: cd server && node --test core/dataEngine/aggregateRelated.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
require('../../testUtils/routeHarness').recordDb();

const { relatedForAggregate } = require('./aggregateRelated.mts');
const { computeParamsHash } = require('../../appStudio/datasetCache');
const { _test: render } = require('../../services/appStudioRender');

const CUSTOMERS = {
    id: 'tbl_cust01', key: 'customers',
    fields: [{ id: 'f1', key: 'name', type: 'text' }, { id: 'f2', key: 'segment', type: 'text' }],
    access: { default: 'none', roles: { member: { read: 'all' } }, rowFilters: { member: 'record.segment == viewer.segment' } },
};
const ORDERS = {
    id: 'tbl_ord01', key: 'orders',
    fields: [{ id: 'f3', key: 'amount', type: 'number' }, { id: 'f4', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01' } }],
    access: { default: 'none', roles: { member: { read: 'own' }, outsider: { read: 'own' } } },
};
const MODEL = { tables: [ORDERS, CUSTOMERS] };
const VIA = [{ field: 'customer', relatedField: 'name' }];

test('nothing for a descriptor that does not go through a relation', () => {
    for (const groupBy of [undefined, null, [], [{ field: 'customer' }], { kind: 'formula', expr: 'vars.g' }]) {
        assert.strictEqual(relatedForAggregate(MODEL, ORDERS, groupBy, { role: 'member', viewer: { id: 'u1' } }), undefined);
    }
});

test('the related table under the viewer\'s own predicate, or one that matches nothing', () => {
    const member = relatedForAggregate(MODEL, ORDERS, VIA, { role: 'member', viewer: { id: 'u1', segment: 'retail' } });
    assert.deepStrictEqual(Object.keys(member), ['customer']);
    assert.strictEqual(member.customer.tableMeta, CUSTOMERS);
    assert.deepStrictEqual(member.customer.accessFilter.params, ['retail']);
    const outsider = relatedForAggregate(MODEL, ORDERS, VIA, { role: 'outsider', viewer: { id: 'u1' } });
    assert.deepStrictEqual(outsider.customer.accessFilter, { where: '1=0', params: [] });
});

test('a field that is no relation, or a target outside the app\'s own storage, is not handed over', () => {
    assert.strictEqual(relatedForAggregate(MODEL, ORDERS, [{ field: 'amount', relatedField: 'x' }], { role: 'owner', viewer: {} }), undefined);
    const linked = { tables: [ORDERS, { ...CUSTOMERS, source: { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' } }] };
    assert.strictEqual(relatedForAggregate(linked, ORDERS, VIA, { role: 'owner', viewer: {} }), undefined);
    assert.strictEqual(relatedForAggregate({ tables: [ORDERS] }, ORDERS, VIA, { role: 'owner', viewer: {} }), undefined);
});

test('groupFilter joins the dataset params hash and the render key only when present', () => {
    const d = { groupBy: [{ field: 'customer' }], aggregates: [{ fn: 'count', as: 'n' }] };
    assert.strictEqual(computeParamsHash('orders', { ...d, groupFilter: null }), computeParamsHash('orders', d));
    assert.notStrictEqual(computeParamsHash('orders', { ...d, groupFilter: [{ field: 'n', op: 'gt', value: 1 }] }), computeParamsHash('orders', d));
    const b = { kind: 'aggregate', tableId: 'tbl_ord01', ...d };
    assert.strictEqual(render.dataCacheKey(b), 'aggregate:tbl_ord01:{"aggregates":[{"as":"n","fn":"count"}],"filter":null,"groupBy":[{"field":"customer"}],"limit":null,"sort":null}');
    assert.ok(render.dataCacheKey({ ...b, groupFilter: [{ field: 'n', op: 'gt', value: 1 }] }).includes('"groupFilter":['));
});
