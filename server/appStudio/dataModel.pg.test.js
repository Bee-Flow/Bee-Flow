/**
 * Data model — PG DIALECT DDL + reserved-prefix validation (wave B2).
 *
 *   • pgType(): the fixed field→PG-type map (NUMERIC/BIGINT, DATE/TIMESTAMPTZ,
 *     BOOLEAN, TEXT-holding-JSON for multiselect/file — deliberately NOT jsonb);
 *   • ddlForTable() under 'pg': TIMESTAMPTZ system columns, GENERATED … STORED
 *     computed columns, FK references, unique indexes, TRUE/FALSE bool defaults;
 *   • addColumnDdl() under 'pg': ADD COLUMN IF NOT EXISTS (native replay
 *     tolerance) — and migrationPlan flows through both;
 *   • table/field keys starting with pg_ / sqlite_ are validation errors in
 *     BOTH dialects (they could shadow engine internals);
 *   • the sqlite dialect output stays byte-identical to before (guarded by
 *     dataModel.test.js; spot-checked here after flipping the flag back).
 *
 * Pure — no DB. Run: cd server && node --test appStudio/dataModel.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const engineFlag = require('./engineFlag');
const dm = require('./dataModel');

const f = (over) => ({ id: 'fld_aaaa11', key: 'x', required: false, unique: false, ...over });

// ── pgType map ──────────────────────────────────────────────────────

test('pgType maps every field type to the fixed PG column type', () => {
    assert.strictEqual(dm.pgType(f({ type: 'text' })), 'TEXT');
    assert.strictEqual(dm.pgType(f({ type: 'richtext' })), 'TEXT');
    assert.strictEqual(dm.pgType(f({ type: 'select' })), 'TEXT');
    assert.strictEqual(dm.pgType(f({ type: 'relation' })), 'TEXT');
    assert.strictEqual(dm.pgType(f({ type: 'number' })), 'NUMERIC');
    assert.strictEqual(dm.pgType(f({ type: 'number', subtype: 'integer' })), 'BIGINT');
    assert.strictEqual(dm.pgType(f({ type: 'date' })), 'DATE');
    assert.strictEqual(dm.pgType(f({ type: 'datetime' })), 'TIMESTAMPTZ');
    assert.strictEqual(dm.pgType(f({ type: 'bool' })), 'BOOLEAN');
    // multiselect/file hold JSON as TEXT — the compiler JSON-stringifies and
    // the wire format treats them as opaque text in both dialects, NOT jsonb.
    assert.strictEqual(dm.pgType(f({ type: 'multiselect' })), 'TEXT');
    assert.strictEqual(dm.pgType(f({ type: 'file' })), 'TEXT');
    // computed → declared result type
    assert.strictEqual(dm.pgType(f({ type: 'computed', computed: { expr: 'a', type: 'number' } })), 'NUMERIC');
    assert.strictEqual(dm.pgType(f({ type: 'computed', computed: { expr: 'a', type: 'integer' } })), 'BIGINT');
    assert.strictEqual(dm.pgType(f({ type: 'computed', computed: { expr: 'a' } })), 'TEXT');
});

// ── pg DDL for a full table ─────────────────────────────────────────

const FULL_TABLE = {
    id: 'tbl_full01',
    key: 'orders',
    fields: [
        { id: 'fld_1', key: 'title', type: 'text', required: true },
        { id: 'fld_2', key: 'amount', type: 'number', default: 2.5 },
        { id: 'fld_3', key: 'qty', type: 'number', subtype: 'integer' },
        { id: 'fld_4', key: 'due', type: 'date' },
        { id: 'fld_5', key: 'placed_at', type: 'datetime' },
        { id: 'fld_6', key: 'paid', type: 'bool', default: true },
        { id: 'fld_7', key: 'tags', type: 'multiselect', options: [] },
        { id: 'fld_8', key: 'invoice', type: 'file' },
        { id: 'fld_9', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01' }, unique: false },
        { id: 'fld_10', key: 'sku', type: 'text', unique: true },
        { id: 'fld_11', key: 'total', type: 'computed', computed: { expr: 'amount * qty', stored: true, type: 'number' } },
        { id: 'fld_12', key: 'label', type: 'computed', computed: { expr: 'upper(title)' } }, // read-time → no column
    ],
};
const KEYS = new Map([['tbl_cust01', 'customers'], ['tbl_full01', 'orders']]);

test('pg ddlForTable: TIMESTAMPTZ system columns, real types, GENERATED … STORED, unique index', (t) => {
    engineFlag._setForTests('pg');
    t.after(() => engineFlag._setForTests(null));
    const ddl = dm.ddlForTable(FULL_TABLE, { tableKeyById: KEYS });

    assert.match(ddl, /"id" is not|id TEXT PRIMARY KEY/, 'id stays TEXT PRIMARY KEY (rec_* ids)');
    assert.match(ddl, /created_at TIMESTAMPTZ/, 'created_at is a real timestamp under pg');
    assert.match(ddl, /updated_at TIMESTAMPTZ/);
    assert.match(ddl, /created_by TEXT/);
    assert.match(ddl, /org_id TEXT/);

    assert.match(ddl, /"title" TEXT NOT NULL/);
    assert.match(ddl, /"amount" NUMERIC DEFAULT 2\.5/);
    assert.match(ddl, /"qty" BIGINT/);
    assert.match(ddl, /"due" DATE/);
    assert.match(ddl, /"placed_at" TIMESTAMPTZ/);
    assert.match(ddl, /"paid" BOOLEAN DEFAULT TRUE/, 'bool default renders TRUE, not 1 (pg rejects integer defaults on BOOLEAN)');
    assert.match(ddl, /"tags" TEXT/);
    assert.match(ddl, /"invoice" TEXT/);
    assert.match(ddl, /"customer" TEXT REFERENCES "customers"\(id\)/);
    assert.match(ddl, /"total" NUMERIC GENERATED ALWAYS AS \(amount \* qty\) STORED/);
    assert.ok(!ddl.includes('"label"'), 'read-time computed gets no physical column');
    assert.match(ddl, /CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_full01_fld_10" ON "orders" \("sku"\)/);
    assert.ok(!/\bREAL\b|\bINTEGER\b(?! PRIMARY)/.test(ddl.replace('id TEXT PRIMARY KEY', '')), 'no sqlite affinities leak into pg DDL');
});

test('pg addColumnDdl: ADD COLUMN IF NOT EXISTS (+ unique index follow-up)', (t) => {
    engineFlag._setForTests('pg');
    t.after(() => engineFlag._setForTests(null));
    const stmts = dm._addColumnDdl('orders', 'tbl_full01', {
        id: 'fld_13', key: 'ref', type: 'text', unique: true,
    }, KEYS);
    assert.strictEqual(stmts.length, 2);
    assert.match(stmts[0], /^ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ref" TEXT$/);
    assert.match(stmts[1], /CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_full01_fld_13" ON "orders" \("ref"\)/);

    const boolCol = dm._addColumnDdl('orders', 'tbl_full01', {
        id: 'fld_14', key: 'flag', type: 'bool', default: false,
    }, KEYS);
    assert.match(boolCol[0], /ADD COLUMN IF NOT EXISTS "flag" BOOLEAN DEFAULT FALSE/);
});

test('pg migrationPlan emits pg-typed DDL end to end', (t) => {
    engineFlag._setForTests('pg');
    t.after(() => engineFlag._setForTests(null));
    const oldModel = { tables: [] };
    const newModel = { tables: [FULL_TABLE] };
    const plan = dm.migrationPlan(oldModel, newModel);
    assert.strictEqual(plan.length, 1);
    assert.match(plan[0], /TIMESTAMPTZ/);
    assert.match(plan[0], /GENERATED ALWAYS AS/);

    const plan2 = dm.migrationPlan(newModel, {
        tables: [{ ...FULL_TABLE, fields: [...FULL_TABLE.fields, { id: 'fld_15', key: 'extra', type: 'number' }] }],
    });
    assert.deepStrictEqual(plan2, ['ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "extra" NUMERIC']);
});

test('sqlite dialect DDL is unchanged after the port (flag back to default)', () => {
    engineFlag._setForTests(null);
    const ddl = dm.ddlForTable(FULL_TABLE, { tableKeyById: KEYS });
    assert.match(ddl, /created_at TEXT/);
    assert.match(ddl, /"amount" REAL DEFAULT 2\.5/);
    assert.match(ddl, /"qty" INTEGER/);
    assert.match(ddl, /"paid" INTEGER DEFAULT 1/);
    assert.match(ddl, /"due" TEXT/);
    assert.ok(!ddl.includes('TIMESTAMPTZ') && !ddl.includes('BOOLEAN') && !ddl.includes('NUMERIC'));
    const add = dm._addColumnDdl('orders', 'tbl_full01', { id: 'fld_16', key: 'plain', type: 'text' }, KEYS);
    assert.deepStrictEqual(add, ['ALTER TABLE "orders" ADD COLUMN "plain" TEXT'], 'no IF NOT EXISTS under sqlite');
});

// ── reserved key prefixes (both dialects) ───────────────────────────

function modelWithKeys(tableKey, fieldKey) {
    return {
        modelVersion: 1,
        tables: [{
            id: 'tbl_abc123', key: tableKey, name: 'T',
            fields: [{ id: 'fld_abc123', key: fieldKey, type: 'text', name: 'F' }],
            access: { default: 'app', roles: {}, rowFilters: {} },
        }],
        roles: [],
        roleMapping: { default: 'app', byGroup: {} },
    };
}

test('table/field keys starting with pg_ or sqlite_ are rejected in BOTH dialects', (t) => {
    for (const dialect of ['sqlite', 'pg']) {
        engineFlag._setForTests(dialect);
        for (const bad of ['pg_stats', 'sqlite_master', 'pg_x', 'sqlite_seq']) {
            const asTable = dm.validateDataModel(modelWithKeys(bad, 'ok'));
            assert.ok(asTable.errors.some(e => e.includes('reserved engine prefix')),
                `${dialect}: table key ${bad} → ${JSON.stringify(asTable.errors)}`);
            const asField = dm.validateDataModel(modelWithKeys('ok_tbl', bad));
            assert.ok(asField.errors.some(e => e.includes('reserved engine prefix')),
                `${dialect}: field key ${bad} → ${JSON.stringify(asField.errors)}`);
        }
        // Non-prefix uses of the words stay legal.
        const fine = dm.validateDataModel(modelWithKeys('my_pg_table', 'has_sqlite_inside'));
        assert.deepStrictEqual(fine.errors, [], `${dialect}: prefixes only match at the start`);
    }
    t.after(() => engineFlag._setForTests(null));
    engineFlag._setForTests(null);
});

test('RESERVED_KEY_PREFIX_RE is exported and anchored', () => {
    assert.ok(dm.RESERVED_KEY_PREFIX_RE.test('pg_a'));
    assert.ok(dm.RESERVED_KEY_PREFIX_RE.test('sqlite_a'));
    assert.ok(!dm.RESERVED_KEY_PREFIX_RE.test('a_pg_b'));
});
