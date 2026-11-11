// @typecheck
'use strict';

/**
 * expand, fields and `<relation>.<field>` filters on a record / records
 * binding: what the validator accepts and refuses (against a real data model
 * through validateAppDefinition), that a linked Studio table is refused by
 * name, that a WRITE filter does not take a relation path, and that the
 * canonicalizer keeps them while a binding without them gains nothing.
 *
 * Run: node --test appStudio/validate/relationReadChecks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { expandAlias } = require('./relationReadChecks.mts');

const MODEL = {
    tables: [
        {
            id: 'tbl_ord01', key: 'orders', name: 'Orders',
            fields: [
                { id: 'fld_o1', key: 'amount', type: 'number' },
                { id: 'fld_o2', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01', displayField: 'name' } },
                { id: 'fld_o3', key: 'channel', type: 'text' },
                { id: 'fld_o4', key: 'feed', type: 'relation', relation: { table: 'tbl_link01' } },
                { id: 'fld_o5', key: 'feed_record', type: 'text' },
            ],
        },
        {
            id: 'tbl_cust01', key: 'customers', name: 'Customers',
            fields: [{ id: 'fld_c1', key: 'name', type: 'text' }, { id: 'fld_c2', key: 'region', type: 'text' }],
        },
        {
            id: 'tbl_link01', key: 'feed', name: 'Feed', source: { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' },
            fields: [{ id: 'fld_l1', key: 'label', type: 'text' }, { id: 'fld_l2', key: 'owner', type: 'relation', relation: { table: 'tbl_cust01' } }],
        },
    ],
};

const defWith = (/** @type {unknown} */ source, /** @type {Record<string, unknown>} */ extra = {}) => ({
    schemaVersion: 2, name: 'T', ...extra,
    screens: [{ id: 'scr_aaaaaa', name: 'S', sections: [{ id: 'sec_aaaaaa', children: [{ id: 'cmp_aaaaaa', type: 'table', props: { columns: [], source } }] }] }],
});

/** The findings on the binding of a table bound to `extra` over orders. */
function findings(/** @type {Record<string, unknown>} */ extra, tableId = 'tbl_ord01') {
    const source = { kind: 'records', tableId, ...extra };
    const { errors } = validateAppDefinition(defWith(source), { dataModel: MODEL, datatables: ['tbl_dt0001'] });
    return errors.filter((e) => e.path.includes('.source')).map((e) => `${e.code}@${e.path.slice(e.path.indexOf('source'))}`);
}
const messages = (/** @type {Record<string, unknown>} */ extra, tableId = 'tbl_ord01') => validateAppDefinition(defWith({ kind: 'records', tableId, ...extra }), { dataModel: MODEL, datatables: ['tbl_dt0001'] })
    .errors.filter((e) => e.path.includes('.source')).map((e) => e.message);

test('expand, fields and a relation filter validate clean when they are used right', () => {
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer' }] }), []);
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer', pick: ['name', 'region', 'created_at'], as: 'buyer' }] }), []);
    assert.deepStrictEqual(findings({ fields: ['amount', 'channel', 'id'] }), []);
    assert.deepStrictEqual(findings({ filter: [{ field: 'customer.region', op: 'eq', value: 'north' }] }), []);
    assert.deepStrictEqual(findings({ filter: [{ any: [{ field: 'customer.name', op: 'contains', value: { kind: 'formula', expr: 'vars.q' } }, { not: { field: 'customer.region', op: 'isNull' } }] }] }), []);
    const record = validateAppDefinition(defWith({ kind: 'record', tableId: 'tbl_ord01', expand: [{ field: 'customer' }], fields: ['amount'] }), { dataModel: MODEL }).errors;
    assert.deepStrictEqual(record.filter((e) => e.path.includes('.source')), []);
    const aggregate = validateAppDefinition(defWith({ kind: 'aggregate', tableId: 'tbl_ord01', aggregates: [{ fn: 'count', as: 'n' }], filter: [{ field: 'customer.region', op: 'eq', value: 'x' }] }), { dataModel: MODEL }).errors;
    assert.deepStrictEqual(aggregate.filter((e) => e.path.includes('.source')), []);
});

test('expand: the shape, the relation, the picked fields and the name it lands in', () => {
    const bad = 'binding.relation_read_invalid';
    assert.deepStrictEqual(findings({ expand: [] }), [`${bad}@source.expand`]);
    assert.deepStrictEqual(findings({ expand: { field: 'customer' } }), [`${bad}@source.expand`]);
    assert.deepStrictEqual(findings({ expand: Array.from({ length: 6 }, (_, i) => ({ field: 'customer', as: `c${i}` })) }), [`${bad}@source.expand`]);
    assert.deepStrictEqual(findings({ expand: ['customer'] }), [`${bad}@source.expand[0]`]);
    assert.deepStrictEqual(findings({ expand: [{ pick: ['name'] }] }), [`${bad}@source.expand[0].field`]);
    assert.deepStrictEqual(findings({ expand: [{ field: 'channel' }] }), [`${bad}@source.expand[0].field`]);
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer', pick: [] }] }), [`${bad}@source.expand[0].pick`]);
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer', pick: ['name', 'ssn', 7] }] }), ['binding.unknown_field@source.expand[0].pick[1]', `${bad}@source.expand[0].pick[2]`]);
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer', as: 'amount' }] }), [`${bad}@source.expand[0].as`]);
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer', as: 'created_at' }] }), [`${bad}@source.expand[0].as`]);
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer', as: '9 lives' }] }), [`${bad}@source.expand[0].as`]);
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer' }, { field: 'customer' }] }), [`${bad}@source.expand[1]`]);
    assert.deepStrictEqual(findings({ expand: [{ field: 'customer', expand: [{ field: 'x' }] }] }), [`${bad}@source.expand[0].expand`]);
});

test('a linked Studio table is refused by name: expanding it, expanding into it, filtering through it', () => {
    assert.match(messages({ expand: [{ field: 'feed', as: 'f' }] })[0], /points at a linked Studio table, which cannot be read through a relation/);
    assert.match(messages({ expand: [{ field: 'owner' }] }, 'tbl_link01')[0], /A linked Studio table cannot expand a relation/);
    assert.match(messages({ filter: [{ field: 'feed.label', op: 'eq', value: 'x' }] })[0], /points at a linked Studio table/);
    assert.match(messages({ filter: [{ field: 'owner.name', op: 'eq', value: 'x' }] }, 'tbl_link01')[0], /A linked Studio table cannot be filtered through a relation/);
    // The default name of an expansion can collide with a field: say so.
    assert.deepStrictEqual(findings({ expand: [{ field: 'feed' }] }).length, 1);
});

test('fields: a list of field keys of the table', () => {
    const bad = 'binding.relation_read_invalid';
    assert.deepStrictEqual(findings({ fields: [] }), [`${bad}@source.fields`]);
    assert.deepStrictEqual(findings({ fields: 'amount' }), [`${bad}@source.fields`]);
    assert.deepStrictEqual(findings({ fields: ['amount', 'nope', 3] }), ['binding.unknown_field@source.fields[1]', `${bad}@source.fields[2]`]);
    assert.deepStrictEqual(findings({ fields: ['customer.name'] }), ['binding.unknown_field@source.fields[0]']);
});

test('a relation filter: one relation deep, a real column of the related table, a value, at most five', () => {
    const bad = 'binding.relation_read_invalid';
    const f = (/** @type {Record<string, unknown>} */ clause) => findings({ filter: [clause] });
    assert.deepStrictEqual(f({ field: 'customer.owner.name', op: 'eq', value: 'x' }), [`${bad}@source.filter[0].field`]);
    assert.deepStrictEqual(f({ field: 'customer.', op: 'eq', value: 'x' }), [`${bad}@source.filter[0].field`]);
    assert.deepStrictEqual(f({ field: 'channel.name', op: 'eq', value: 'x' }), [`${bad}@source.filter[0].field`]);
    assert.deepStrictEqual(f({ field: 'customer.ssn', op: 'eq', value: 'x' }), ['binding.unknown_field@source.filter[0].field']);
    assert.ok(f({ field: 'customer.region', op: 'gt', otherField: 'channel' }).includes(`${bad}@source.filter[0].otherField`));
    assert.deepStrictEqual(findings({ filter: Array.from({ length: 6 }, () => ({ field: 'customer.region', op: 'neq', value: 'x' })) }), [`${bad}@source.filter`]);
});

test('a write filter does not take a relation path', () => {
    const step = { kind: 'update_record', tableId: 'tbl_ord01', filter: [{ field: 'customer.region', op: 'eq', value: 'north' }], values: { channel: { kind: 'static', value: 'web' } } };
    const def = defWith({ kind: 'records', tableId: 'tbl_ord01' }, { actions: { act_aaaaaa: { kind: 'sequence', steps: [step] } } });
    const { errors } = validateAppDefinition(canonicalizeAppDefinition(def).def, { dataModel: MODEL });
    assert.ok(errors.some((e) => e.code === 'binding.unknown_field' && e.path.endsWith('filter[0].field')), JSON.stringify(errors.map((e) => `${e.code}@${e.path}`)));
});

test('canonicalize keeps expand and fields; a binding without them gains nothing', () => {
    const rich = { kind: 'records', tableId: 'tbl_ord01', filter: [{ field: 'customer.region', op: 'eq', value: 'north' }], expand: [{ field: 'customer', pick: ['name'], as: 'buyer' }], fields: ['amount'] };
    const plain = { kind: 'records', tableId: 'tbl_ord01', filter: [{ field: 'channel', op: 'eq', value: 'web' }] };
    const sourceOf = (/** @type {unknown} */ b) => canonicalizeAppDefinition(defWith(b)).def.screens[0].sections[0].children[0].props.source;
    assert.deepStrictEqual(sourceOf(rich), rich);
    assert.deepStrictEqual(sourceOf({ ...rich, kind: 'record' }), { ...rich, kind: 'record' });
    assert.deepStrictEqual(Object.keys(sourceOf(plain)), ['kind', 'tableId', 'filter']);
    // An aggregate has no rows to expand: the keys are not carried there.
    assert.deepStrictEqual(Object.keys(sourceOf({ kind: 'aggregate', tableId: 'tbl_ord01', aggregates: [{ fn: 'count', as: 'n' }], expand: [{ field: 'customer' }], fields: ['amount'] })).sort(), ['aggregates', 'kind', 'tableId']);
});

test('the name an expansion lands in', () => {
    assert.strictEqual(expandAlias({ field: 'customer' }), 'customer_record');
    assert.strictEqual(expandAlias({ field: 'customer', as: 'buyer' }), 'buyer');
    assert.strictEqual(expandAlias({}), null);
});
