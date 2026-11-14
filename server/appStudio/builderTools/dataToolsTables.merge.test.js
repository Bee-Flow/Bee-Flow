/**
 * mergeTableOp, the pure part of app_upsert_table: every refusal and every
 * hint, in the order a call meets them, and the table it stores. New ids are
 * random, so they are compared by shape.
 *
 * Run: cd server && node --test appStudio/builderTools/dataToolsTables.merge.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeTableOp } = require('./dataToolsTables');

const fld = (id, key, type = 'text', extra = {}) => ({ id, key, name: key, type, required: false, ...extra });
const ORDERS = { id: 'tbl_orders01', key: 'orders', name: 'Orders', icon: 'box', fields: [fld('fld_title001', 'title'), fld('fld_total001', 'total', 'number')], indexes: [{ fields: ['title'] }] };
const LINKED = { id: 'tbl_linked01', key: 'linked', name: 'Linked', icon: null, source: { kind: 'datatable', datatableId: 'dt_1' }, fields: [fld('fld_a0000001', 'a')] };
const model = (...tables) => ({ schemaVersion: 3, tables });
const keep = (t) => t.fields.map((f) => ({ fieldId: f.id, key: f.key, type: f.type }));

test('an unknown tableId is refused, with the closest id when there is one', () => {
    const near = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders02', fields: [] });
    assert.equal(near.error, 'Unknown tableId "tbl_orders02". Did you mean "tbl_orders01"?');
    assert.match(near._fixHint, / Omit tableId to create a new table\.$/);
    assert.equal(mergeTableOp(model(ORDERS), { tableId: 'zzz', fields: [] }).error, 'Unknown tableId "zzz".');
});

test('a create with a source is sent to app_link_datatable', () => {
    const r = mergeTableOp(model(), { key: 'x', source: { kind: 'datatable' }, fields: [{ key: 'a', type: 'text' }] });
    assert.match(r.error, /call app_link_datatable\.$/);
    assert.match(r._fixHint, /^app_link_datatable \{ name:/);
});

test('a linked table keeps its source fields: a different list is refused, the same or none is fine', () => {
    assert.ok(mergeTableOp(model(LINKED), { tableId: 'tbl_linked01', fields: [{ key: 'b', type: 'text' }] }).error);
    const same = mergeTableOp(model(LINKED), { tableId: 'tbl_linked01', name: 'Renamed', fields: [{ key: 'a', type: 'text' }] });
    assert.deepEqual([same.error, same.table.name, same.table.fields.map((f) => f.key)], [undefined, 'Renamed', ['a']]);
    const none = mergeTableOp(model(LINKED), { tableId: 'tbl_linked01', icon: 'star' });
    assert.deepEqual([none.error, none.table.icon, none.table.fields.map((f) => f.id)], [undefined, 'star', ['fld_a0000001']]);
    assert.equal(mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01' }).error, 'fields must be a non-empty array of { key, type, … } — the table\'s COMPLETE field list.');
});

test('the key: given, kept, derived from the name with a hint, missing, malformed or taken', () => {
    for (const key of [5, 'Bad Key', '1abc']) {
        assert.equal(mergeTableOp(model(), { key, fields: [{ key: 'a', type: 'text' }] }).error, `key ${JSON.stringify(key)} must be lowercase snake_case starting with a letter (max 63 chars), e.g. "tasks".`);
    }
    const derived = mergeTableOp(model(ORDERS), { name: 'Klant Contacten', fields: [{ key: 'a', type: 'text' }] });
    assert.equal(derived.table.key, 'klant_contacten');
    assert.deepEqual(derived.hints, ['key derived from name: "Klant Contacten" → klant_contacten.']);
    assert.equal(mergeTableOp(model(), { name: '  ', fields: [{ key: 'a', type: 'text' }] }).error, 'key is required when creating a table (lowercase snake_case, e.g. "tasks") — or give the table a name and the key is derived from it.');
    const taken = mergeTableOp(model(ORDERS), { key: 'orders', fields: [{ key: 'a', type: 'text' }] });
    assert.deepEqual(taken, { error: 'A table with key "orders" already exists (tbl_orders01).', _fixHint: 'Pass its tableId to evolve that table, or pick a different key.' });
    const kept = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: keep(ORDERS) });
    assert.deepEqual([kept.table.key, kept.table.name, kept.table.icon, kept.table.indexes, kept.hints], ['orders', 'Orders', 'box', [{ fields: ['title'] }], []]);
});

test('the field list: empty, too long, an entry that is not an object, an entry the checks refuse', () => {
    assert.match(mergeTableOp(model(), { key: 'x', fields: [] }).error, /^fields must be a non-empty array/);
    assert.equal(mergeTableOp(model(), { key: 'x', fields: Array.from({ length: 101 }, (_, i) => ({ key: `f${i}`, type: 'text' })) }).error, 'fields: max 100 fields per table.');
    assert.equal(mergeTableOp(model(), { key: 'x', fields: [{ key: 'a', type: 'text' }, ['x']] }).error, 'fields[1] must be an object { key, type, … }.');
    assert.ok(mergeTableOp(model(), { key: 'x', fields: [{ key: 'a', type: 'bogus' }] }).error);
    assert.match(mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: [{ fieldId: 'fld_nope', key: 'title', type: 'text' }] }).error, /^fields\[0\]\.fieldId "fld_nope" does not exist on tbl_orders01\./);
    assert.match(mergeTableOp(model(), { key: 'x', fields: [{ key: 'c', type: 'computed' }] }).error, /^fields\[0\] \(computed\) requires computed/);
});

test('type changes on a table with rows: a safe pair is a hint, any other a refusal', () => {
    const toNumber = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: [{ fieldId: 'fld_title001', key: 'title', type: 'number' }, keep(ORDERS)[1]] }, { tbl_orders01: '7' });
    assert.deepEqual(toNumber.hints, ['Field "title" converts text → number on save (7 row(s)). Values that cannot convert refuse the save unless onUnconvertible:"clear"; dryRun:true counts them first.']);
    const toDate = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: [{ fieldId: 'fld_title001', key: 'title', type: 'date' }, keep(ORDERS)[1]] });
    assert.match(toDate.error, /^Field "title" is text — only text↔select/);
    assert.match(toDate._fixHint, /^Add a NEW field/);
});

test('a new required field without a default on a populated table: a hint, not on a new table or with a default', () => {
    const fields = [...keep(ORDERS), { key: 'due', type: 'text', required: true }];
    const populated = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields }, { tbl_orders01: 3 });
    assert.deepEqual(populated.hints, ['Field "due" is required with no default on a table holding 3 row(s) — the 3 existing row(s) keep it empty and only NEW writes enforce it. Give it a default to backfill.']);
    assert.deepEqual(mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields }, { tbl_orders01: 0 }).hints, []);
    assert.deepEqual(mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: [...keep(ORDERS), { key: 'due', type: 'text', required: true, default: 'x' }] }, { tbl_orders01: 3 }).hints, []);
    assert.deepEqual(mergeTableOp(model(), { key: 'fresh', fields: [{ key: 'due', type: 'text', required: true }] }, { tbl_x: 3 }).hints, []);
    const madeRequired = [{ ...keep(ORDERS)[0], required: true }, keep(ORDERS)[1]];
    assert.deepEqual(mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: madeRequired }, { tbl_orders01: 3 }).hints, [], 'an existing field made required is no new column');
});

test('hints after the list: a new read-time computed field, derived field keys, dropped fields', () => {
    const r = mergeTableOp(model(ORDERS), {
        tableId: 'tbl_orders01',
        fields: [keep(ORDERS)[0], { key: 'twice', type: 'computed', computed: { expr: 'total * 2', type: 'number' } }, { name: 'Due Date', type: 'date' }],
    });
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.hints.length, 3);
    assert.match(r.hints[0], /^Field "twice" is a read-time computed field and reads empty: /);
    assert.equal(r.hints[1], 'field keys derived from names: "Due Date" → due_date.');
    assert.equal(r.hints[2], 'Dropped field(s) total — they were missing from fields[] (the array is the COMPLETE field list); their column data is deleted.');
    const ok = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: [...keep(ORDERS), { key: 'twice', type: 'computed', computed: { expr: 'total * 2', type: 'number' } }] });
    assert.match(ok.hints[0], /^Field "twice" is a read-time computed field: it is worked out on every read/);
    const stored = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: [...keep(ORDERS), { key: 'twice', type: 'computed', computed: { expr: 'total * 2', type: 'number', stored: true } }] });
    assert.deepEqual(stored.hints, []);
});

test('a relation must point at a table of the next model; a self-relation is fine', () => {
    const unknown = mergeTableOp(model(ORDERS), { key: 'lines', fields: [{ key: 'order', type: 'relation', relation: { table: 'tbl_gone' } }] });
    assert.equal(unknown.error, 'Field "order" points at unknown table "tbl_gone".');
    assert.match(unknown._fixHint, /Create the parent table first/);
    const toOrders = mergeTableOp(model(ORDERS), { key: 'lines', fields: [{ key: 'order', type: 'relation', relation: { table: 'tbl_orders01' } }] });
    assert.equal(toOrders.error, undefined);
    const self = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', fields: [...keep(ORDERS), { key: 'parent', type: 'relation', relation: { table: 'tbl_orders01' } }] });
    assert.equal(self.error, undefined);
});

test('name, icon, access and indexes as stored; a malformed access is refused', () => {
    const r = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', name: '', icon: null, access: { default: 'read' }, indexes: null, fields: keep(ORDERS) });
    assert.deepEqual([r.table.name, r.table.icon, r.table.access, 'indexes' in r.table], ['Orders', null, { default: 'read' }, false]);
    const replaced = mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', indexes: [{ fields: ['total'] }], fields: keep(ORDERS) });
    assert.deepEqual(replaced.table.indexes, [{ fields: ['total'] }]);
    for (const access of [null, 'x', ['a']]) {
        assert.equal(mergeTableOp(model(ORDERS), { tableId: 'tbl_orders01', access, fields: keep(ORDERS) }).error, 'access must be an object { default, roles?, rowFilters? }.');
    }
    const created = mergeTableOp(model(ORDERS), { key: 'notes', fields: [{ key: 'body', type: 'text' }] });
    assert.match(created.table.id, /^tbl_/);
    assert.deepEqual([created.table.name, created.table.icon, created.model.tables.length, created.model.schemaVersion], ['notes', null, 2, 3]);
});

test('the input model is never touched, and a create past the table limit is refused', () => {
    const m = model(ORDERS);
    const before = JSON.stringify(m);
    mergeTableOp(m, { tableId: 'tbl_orders01', name: 'X', fields: [{ key: 'a', type: 'text' }] });
    assert.equal(JSON.stringify(m), before);
    const full = model(...Array.from({ length: 50 }, (_, i) => ({ id: `tbl_t${i}`, key: `t${i}`, name: `t${i}`, fields: [fld(`fld_${i}`, 'a')] })));
    assert.equal(mergeTableOp(full, { key: 'one_more', fields: [{ key: 'a', type: 'text' }] }).error, 'The app already has 50 tables (the maximum).');
    assert.equal(mergeTableOp(full, { tableId: 'tbl_t0', fields: [{ key: 'b', type: 'text' }] }).error, undefined);
});
