/**
 * Field rules (core/dataEngine/fieldRules.mts) on every App Studio write path, against a REAL
 * in-memory SQLite: the real query compiler, RLS gateway and dispatcher. Only the Postgres-backed
 * stores are swapped for stand-ins that run the compiled SQL on the database.
 *
 * What it pins: a refusal writes nothing and names each field (by the FORM field it came from, for
 * a step); a dynamic default lands in the row; a field without rules writes exactly as before.
 *
 * Run: cd server && node --test appStudio/actionExecutor/records.fieldRules.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };
const db = new Database(':memory:');

const norm = (params) => params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
const dbStore = require('../../stores/studioAppDbStore');
const dataStore = require('../../stores/studioAppDataStore');
const executed = [];
const swaps = [
    [dbStore, {
        exec: async (_o, _a, sql, params) => { executed.push(sql); return { changes: db.prepare(sql).run(...norm(params)).changes }; },
        query: async (_o, _a, sql, params) => ({ rows: db.prepare(sql).all(...norm(params)) }),
        batch: async (_o, _a, statements) => db.transaction(() => statements.map((s, i) => {
            executed.push(s.sql);
            if (s.sql.trim().toLowerCase().startsWith('select')) return { rows: db.prepare(s.sql).all(...norm(s.params)) };
            const changes = db.prepare(s.sql).run(...norm(s.params)).changes;
            if (s.expectChanges && !changes) throw Object.assign(new Error('no rows'), { code: 'batch_no_rows', statementIndex: i });
            return { changes };
        }))(),
        sizeBytes: async () => 0,
    }],
    [dataStore, {
        bumpDataVersion: async () => 1,
        bumpRowCount: async () => ({}),
        getRowCounts: async () => ({}),
    }],
];
const originals = swaps.map(([target, methods]) => [target, Object.fromEntries(Object.keys(methods).map((k) => [k, target[k]]))]);
swaps.forEach(([target, methods]) => Object.assign(target, methods));
test.after(() => originals.forEach(([target, saved]) => Object.assign(target, saved)));

const dataModel = require('../dataModel');
const { executeDataStep } = require('./dispatch');
const { writeRecord, writeRecordBatch } = require('./records');
const { transactionStep } = require('./transactionStep.mts');

const ORDERS = {
    id: 'tbl_orders', key: 'orders', name: 'Orders',
    fields: [
        { id: 'fld_title0', key: 'title', name: 'Title', type: 'text' },
        { id: 'fld_qty000', key: 'qty', name: 'Quantity', type: 'number', validation: { min: 1, max: 10 } },
        { id: 'fld_code00', key: 'code', name: 'Code', type: 'text', validation: { pattern: '^[A-Z]{3}$', message: 'Use three capital letters.' } },
        { id: 'fld_state0', key: 'state', name: 'State', type: 'select', options: ['open', 'done'], validation: { enforceOptions: true } },
        { id: 'fld_owner0', key: 'owner', name: 'Owner', type: 'text', dynamicDefault: 'currentUser.id' },
        { id: 'fld_day000', key: 'day', name: 'Day', type: 'date', dynamicDefault: 'today' },
    ],
    access: { default: 'app', roles: {}, rowFilters: {} },
};
const PLAIN = {
    id: 'tbl_plain0', key: 'plain', name: 'Plain',
    fields: [{ id: 'fld_qtyp00', key: 'qty', name: 'Quantity', type: 'number' }],
    access: { default: 'app', roles: {}, rowFilters: {} },
};
const MODEL = { modelVersion: 1, roles: [], tables: [ORDERS, PLAIN] };
for (const t of MODEL.tables) db.exec(dataModel.ddlForTable(t, { tableKeyById: new Map(), dialect: 'sqlite' }));

const ownerCtx = (extra = {}) => ({ viewerId: OWNER, viewer: { id: OWNER }, role: 'owner', vars: {}, ...extra });
const rows = (key) => db.prepare(`SELECT * FROM "${key}" ORDER BY created_at, id`).all();

test.beforeEach(() => {
    db.exec('DELETE FROM "orders"; DELETE FROM "plain";');
    executed.length = 0;
});

test('the model validator accepts the rules and the DDL ignores them', () => {
    assert.deepEqual(dataModel.validateDataModel(MODEL).errors, []);
    const bare = { ...ORDERS, fields: ORDERS.fields.map(({ validation: _v, dynamicDefault: _d, ...f }) => f) };
    for (const dialect of ['sqlite', 'pg']) {
        assert.equal(
            dataModel.ddlForTable(ORDERS, { tableKeyById: new Map(), dialect }),
            dataModel.ddlForTable(bare, { tableKeyById: new Map(), dialect }),
            `${dialect}: validation is application-level, never in the DDL`,
        );
    }
});

test('create_record: a breach writes nothing and the errors are keyed by the form fields the step read', async () => {
    const step = {
        kind: 'create_record', tableId: 'tbl_orders',
        values: {
            title: { kind: 'field', name: 'title' },
            qty: { kind: 'field', name: 'amount' },
            code: { kind: 'formula', expr: 'form.order_code' },
            state: { kind: 'static', value: 'later' },
        },
    };
    const res = await executeDataStep(app, MODEL, step, ownerCtx({ formValues: { title: 'A', amount: 0, order_code: 'abc' } }));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'field_invalid');
    assert.equal(res.retryable, false);
    assert.deepEqual(res.fieldErrors, {
        amount: '"Quantity" must be at least 1.',
        order_code: 'Use three capital letters.',
        state: '"State" must be one of the listed options.',
    });
    assert.match(res.error, /^"Quantity" must be at least 1\./);
    assert.deepEqual(rows('orders'), []);
    assert.deepEqual(executed, [], 'nothing was compiled into a statement');
});

test('create_record: valid values land, with the dynamic defaults filled', async () => {
    const step = { kind: 'create_record', tableId: 'tbl_orders', values: { title: { kind: 'static', value: 'B' }, qty: { kind: 'static', value: 3 }, code: { kind: 'static', value: 'ABC' } } };
    const res = await executeDataStep(app, MODEL, step, ownerCtx());
    assert.equal(res.ok, true, JSON.stringify(res));
    const [row] = rows('orders');
    assert.equal(row.owner, OWNER);
    assert.equal(row.day, new Date().toISOString().slice(0, 10));
    assert.equal(row.qty, 3);
});

test('update: only written keys are checked, so a stored row that breaks a later rule can still be edited', async () => {
    db.prepare('INSERT INTO "orders" (id, created_at, updated_at, created_by, org_id, title, qty) VALUES (?,?,?,?,?,?,?)')
        .run('rec_old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', OWNER, 'org-1', 'old', 99);
    const ok = await writeRecord(app, MODEL, ORDERS, { title: 'renamed' }, { viewer: { id: OWNER, role: 'owner' }, recordId: 'rec_old' });
    assert.equal(ok.changes, 1);
    assert.equal(rows('orders')[0].owner, null, 'an update never fills a dynamic default');
    await assert.rejects(
        writeRecord(app, MODEL, ORDERS, { qty: 50 }, { viewer: { id: OWNER, role: 'owner' }, recordId: 'rec_old' }),
        (e) => e.code === 'field_invalid' && e.status === 422 && e.fieldErrors.qty === '"Quantity" must be at most 10.',
    );
    assert.equal(rows('orders')[0].qty, 99);
});

test('writeRecordBatch (ai_extract, connector sync): one bad row refuses the whole batch', async () => {
    await assert.rejects(
        writeRecordBatch(app, MODEL, ORDERS, [{ title: 'a', qty: 2 }, { title: 'b', qty: 20 }], { viewer: { id: OWNER, role: 'owner' } }),
        (e) => e.code === 'field_invalid',
    );
    assert.deepEqual(rows('orders'), []);
    const ids = await writeRecordBatch(app, MODEL, ORDERS, [{ title: 'a', qty: 2 }, { title: 'b' }], { viewer: { id: OWNER, role: 'owner' } });
    assert.equal(ids.length, 2);
    assert.deepEqual(rows('orders').map((r) => r.owner), [OWNER, OWNER]);
});

test('a table without rules writes exactly what it wrote before', async () => {
    await writeRecord(app, MODEL, PLAIN, { qty: 500 }, { viewer: { id: OWNER, role: 'owner' } });
    assert.equal(rows('plain')[0].qty, 500);
});

test('update_record with a filter (bulk) checks the values once, before any row changes', async () => {
    await writeRecord(app, MODEL, ORDERS, { title: 'x', qty: 1 }, { viewer: { id: OWNER, role: 'owner' } });
    const step = { kind: 'update_record', tableId: 'tbl_orders', filter: [{ field: 'title', op: 'eq', value: 'x' }], values: { qty: { kind: 'static', value: 0 } } };
    const res = await executeDataStep(app, MODEL, step, ownerCtx());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'field_invalid');
    assert.deepEqual(res.fieldErrors, { qty: '"Quantity" must be at least 1.' });
    assert.equal(rows('orders')[0].qty, 1);
});

test('transaction: a child that breaks a rule refuses before the batch, so no earlier child is kept', async () => {
    const step = { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_plain0', values: { qty: { kind: 'static', value: 1 } } },
        { kind: 'create_record', tableId: 'tbl_orders', values: { qty: { kind: 'static', value: 11 } } },
    ] };
    await assert.rejects(transactionStep(app, MODEL, step, ownerCtx()), (e) => e.code === 'field_invalid');
    const res = await executeDataStep(app, MODEL, step, ownerCtx());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'field_invalid');
    assert.deepEqual(rows('plain'), []);
    assert.deepEqual(rows('orders'), []);
    const good = await executeDataStep(app, MODEL, { kind: 'transaction', steps: [{ kind: 'create_record', tableId: 'tbl_orders', values: { qty: { kind: 'static', value: 4 } } }] }, ownerCtx());
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(rows('orders')[0].owner, OWNER, 'the transaction create fills dynamic defaults too');
});
