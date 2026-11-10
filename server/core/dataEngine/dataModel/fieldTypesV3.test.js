/**
 * The schema-3 field types (autonumber, json, user) and the text format / display keys: the DDL
 * they produce in BOTH dialects, the migration plan that adds them to a table that already exists
 * (additive only: ADD COLUMN, a numbering UPDATE and a unique index, never a rebuild), the tolerant
 * replay of that plan, and the INSERT that numbers a new row. Real better-sqlite3 for the
 * execution half; the Postgres execution half is fieldTypesV3.pglite.test.js.
 *
 * Run: cd server && node --test core/dataEngine/dataModel/fieldTypesV3.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ddlForTable, addColumnDdl } = require('./ddl');
const { autonumberBackfillDdl } = require('./autonumber');
const { migrationPlan } = require('./migrationPlan');
const { applyPlanTolerantly } = require('./tolerantDdl');
const { compileInsert, compileUpdate } = require('../queryCompilerWrite');

let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch { Database = null; }
const skipIfNoSqlite = (t) => !Database && t.skip('better-sqlite3 native binding unavailable');
const silentLog = { warn: () => {} };

const TITLE = { id: 'fld_title1', key: 'title', type: 'text' };
const NO = { id: 'fld_no0001', key: 'no', type: 'autonumber', unique: true };
const DATA = { id: 'fld_data01', key: 'payload', type: 'json' };
const OWNER = { id: 'fld_owner1', key: 'owner', type: 'user' };
const model = (fields) => ({ modelVersion: 1, tables: [{ id: 'tbl_orders1', key: 'orders', fields }] });

for (const dialect of ['sqlite', 'pg']) {
    test(`${dialect}: CREATE TABLE gives each new type its column and the autonumber its unique index`, () => {
        const sql = ddlForTable({ id: 'tbl_orders1', key: 'orders', fields: [TITLE, NO, DATA, OWNER] }, { dialect });
        assert.match(sql, new RegExp(`"no" ${dialect === 'pg' ? 'BIGINT' : 'INTEGER'},`));
        assert.match(sql, /"payload" TEXT,/);
        assert.match(sql, /"owner" TEXT\n\)/);
        assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_orders1_fld_no0001" ON "orders" \("no"\)/);
    });

    test(`${dialect}: adding the new types to an existing table is additive (no rebuild)`, () => {
        const plan = migrationPlan(model([TITLE]), model([TITLE, NO, DATA, OWNER]), { dialect });
        const add = dialect === 'pg' ? 'ADD COLUMN IF NOT EXISTS' : 'ADD COLUMN';
        assert.deepEqual(plan, [
            `ALTER TABLE "orders" ${add} "no" ${dialect === 'pg' ? 'BIGINT' : 'INTEGER'}`,
            'CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_orders1_fld_no0001" ON "orders" ("no")',
            autonumberBackfillDdl('orders', 'no'),
            `ALTER TABLE "orders" ${add} "payload" TEXT`,
            `ALTER TABLE "orders" ${add} "owner" TEXT`,
        ]);
        for (const s of plan) assert.doesNotMatch(s, /CREATE TABLE|DROP|RENAME/);
    });

    test(`${dialect}: a text format or a display block changes no column`, () => {
        const AMOUNT = { id: 'fld_amnt01', key: 'amount', type: 'number' };
        const before = model([TITLE, AMOUNT]);
        const after = model([{ ...TITLE, format: 'email' }, { ...AMOUNT, display: { currency: 'EUR', decimals: 2 } }]);
        assert.deepEqual(migrationPlan(before, after, { dialect, convertTypes: true }), []);
        assert.deepEqual(migrationPlan(after, before, { dialect, convertTypes: true }), []);
    });
}

test('addColumnDdl of a field that is not an autonumber emits what it always did', () => {
    assert.deepEqual(addColumnDdl('orders', 'tbl_orders1', TITLE, null, 'sqlite'), ['ALTER TABLE "orders" ADD COLUMN "title" TEXT']);
});

test('compileInsert: a table without an autonumber compiles exactly as before', () => {
    const c = compileInsert({ key: 'orders', fields: [TITLE] }, { title: 'a' }, { dialect: 'sqlite', id: 'rec_1' });
    assert.equal(c.sql, 'INSERT INTO "orders" ("id", "created_at", "updated_at", "created_by", "org_id", "title") VALUES (?, ?, ?, ?, ?, ?)');
});

test('compileInsert numbers the row in the statement and ignores a sent number; update never writes it', () => {
    const table = { key: 'orders', fields: [TITLE, NO] };
    const c = compileInsert(table, { title: 'a', no: 999 }, { dialect: 'sqlite', id: 'rec_1' });
    assert.equal(c.sql, 'INSERT INTO "orders" ("id", "created_at", "updated_at", "created_by", "org_id", "title", "no") '
        + 'VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX("no"), 0) + 1 FROM "orders"))');
    assert.equal(c.params.length, 6);
    assert.ok(!c.params.includes(999));
    const u = compileUpdate(table, 'rec_1', { no: 5, title: 'b' }, { where: '1=1', params: [] }, { dialect: 'sqlite' });
    assert.doesNotMatch(u.sql, /"no"/);
});

test('compileInsert stores a json value as JSON text, a string as it is', () => {
    const table = { key: 'orders', fields: [DATA] };
    assert.equal(compileInsert(table, { payload: { a: [1, true] } }, { dialect: 'pg' }).params[5], '{"a":[1,true]}');
    assert.equal(compileInsert(table, { payload: '[1,2]' }, { dialect: 'sqlite' }).params[5], '[1,2]');
    assert.equal(compileInsert(table, { payload: false }, { dialect: 'sqlite' }).params[5], 'false');
});

test('sqlite: rows get 1, 2, 3; a field added later numbers the existing rows; a replay changes nothing', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = new Database(':memory:');
    t.after(() => db.close());
    applyPlanTolerantly(db, migrationPlan({ tables: [] }, model([TITLE])), { log: silentLog });
    const insert = (table, values, at) => {
        const c = compileInsert(table, values, { dialect: 'sqlite' });
        db.prepare(c.sql).run(...c.params.map((p, i) => (i === 1 || i === 2 ? at : p)));
    };
    insert({ key: 'orders', fields: [TITLE] }, { title: 'second' }, '2026-01-02T00:00:00.000Z');
    insert({ key: 'orders', fields: [TITLE] }, { title: 'first' }, '2026-01-01T00:00:00.000Z');

    const plan = migrationPlan(model([TITLE]), model([TITLE, NO]));
    applyPlanTolerantly(db, plan, { log: silentLog });
    insert({ key: 'orders', fields: [TITLE, NO] }, { title: 'third' }, '2026-01-03T00:00:00.000Z');
    const rows = () => db.prepare('SELECT title, no FROM orders ORDER BY no').all().map((r) => [r.title, r.no]);
    assert.deepEqual(rows(), [['first', 1], ['second', 2], ['third', 3]]);

    const replay = applyPlanTolerantly(db, plan, { log: silentLog });
    assert.equal(replay.skipped.length, 1, 'the ADD COLUMN is skipped; the UPDATE and the index are no-ops');
    assert.deepEqual(rows(), [['first', 1], ['second', 2], ['third', 3]]);
    assert.throws(() => db.prepare('INSERT INTO orders (id, no) VALUES (?, ?)').run('dup', 2), /UNIQUE/);
});
