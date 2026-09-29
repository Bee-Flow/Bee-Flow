/**
 * The SQLite → Postgres migrator, exercised end to end against a REAL Postgres
 * (@electric-sql/pglite) and a REAL SQLite source database (better-sqlite3 on a
 * temp file).
 *
 * What must hold, because a migration that is merely "mostly right" is worse
 * than none:
 *   • every row arrives, typed — booleans become booleans, numbers numbers;
 *   • a stored computed column is translated and still computes in Postgres;
 *   • an UNtranslatable computed expression degrades to a plain column that
 *     keeps the values SQLite already materialized, and says so in the report;
 *   • batching (>500 rows) copies everything exactly once;
 *   • a dry run leaves Postgres empty and the app still on sqlite;
 *   • an already-migrated app is skipped, not migrated twice.
 *
 * Run: cd server && node --test scripts/migrateStudioAppsToPg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.STUDIO_APP_ENGINE = 'pg';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { _migrateOne, translateComputedExpr, coerceForPg } = require('./migrateStudioAppsToPg');

const OWNER = 'owner-A';
const APP = 'app-aaaa1111-bbbb-2222-cccc-333333333333';

let pg = null;
let sqliteUsable = true;
let sqlitePath = null;

// ── node-pg-shaped adapters over pglite (same seam the engine uses) ──
function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const command = fields.length > 0 ? 'SELECT' : String(sql).trim().split(/\s+/)[0].toUpperCase();
    const rowCount = fields.length > 0 ? rows.length : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command };
}
async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adaptResult(await pg.exec(sql), sql);
    return adaptResult(await pg.query(sql), sql);
}
const client = { query: (sql, params) => rawQuery(sql, params), release() {} };

// ── The source app: two tables, mixed types, a stored computed column ──
const MODEL = {
    modelVersion: 4,
    tables: [
        {
            id: 'tbl_lines1', key: 'lines',
            fields: [
                { id: 'fld_pos111', key: 'pos', type: 'number', subtype: 'integer' },
                { id: 'fld_name11', key: 'name', type: 'text' },
                { id: 'fld_qty111', key: 'qty', type: 'number' },
                { id: 'fld_done11', key: 'done', type: 'bool' },
                { id: 'fld_when11', key: 'when_at', type: 'datetime' },
                {
                    id: 'fld_csv111', key: 'csv_line', type: 'computed',
                    // The template idiom: char() and the REAL-trimming rtrim pair.
                    computed: {
                        type: 'text', stored: true,
                        expr: "COALESCE(CAST(pos AS TEXT),'') || char(59) || COALESCE(name,'') || char(59) || COALESCE(rtrim(rtrim(CAST(qty AS TEXT),'0'),'.'),'')",
                    },
                },
            ],
        },
        {
            id: 'tbl_notes1', key: 'notes',
            fields: [{ id: 'fld_body11', key: 'body', type: 'text' }],
        },
    ],
};

const BIG_ROWS = 1200; // > the migrator's 500-row batch

function buildSqliteFixture() {
    const Database = require('better-sqlite3');
    const file = path.join(os.tmpdir(), `beeflow-migrate-src-${process.pid}.db`);
    try { fs.unlinkSync(file); } catch { /* fresh */ }
    const db = new Database(file);
    db.exec(`
        CREATE TABLE "lines" (
            "id" TEXT PRIMARY KEY, "created_at" TEXT, "updated_at" TEXT,
            "created_by" TEXT, "org_id" TEXT,
            "pos" INTEGER, "name" TEXT, "qty" REAL, "done" INTEGER, "when_at" TEXT,
            "csv_line" TEXT GENERATED ALWAYS AS (
                COALESCE(CAST(pos AS TEXT),'') || char(59) || COALESCE(name,'') || char(59) || COALESCE(rtrim(rtrim(CAST(qty AS TEXT),'0'),'.'),'')
            ) STORED
        );
        CREATE TABLE "notes" (
            "id" TEXT PRIMARY KEY, "created_at" TEXT, "updated_at" TEXT,
            "created_by" TEXT, "org_id" TEXT, "body" TEXT
        );
    `);
    const insLine = db.prepare(`INSERT INTO "lines" (id, created_at, updated_at, created_by, org_id, pos, name, qty, done, when_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const stamp = '2026-08-07T09:00:00.000Z';
    const many = db.transaction(() => {
        for (let i = 0; i < BIG_ROWS; i++) {
            insLine.run(`rec_${String(i).padStart(6, '0')}`, stamp, stamp, OWNER, 'org1',
                i, `Item ${i}`, 20, i % 2, stamp);
        }
    });
    many();
    db.prepare(`INSERT INTO "notes" (id, created_at, updated_at, created_by, org_id, body) VALUES (?,?,?,?,?,?)`)
        .run('rec_note1', stamp, stamp, OWNER, 'org1', 'hello');
    db.close();
    return file;
}

function deps(overrides = {}) {
    return {
        client,
        log: () => {},
        loadModel: async () => MODEL,
        streamBlob: async () => sqlitePath,
        openSqlite: (file) => new (require('better-sqlite3'))(file, { readonly: true, fileMustExist: true }),
        ...overrides,
    };
}

// The migrator unlinks the blob it was handed (it is a temp download); give it
// a throwaway copy each time so the fixture survives every test.
function copyFixture() {
    const copy = path.join(os.tmpdir(), `beeflow-migrate-copy-${process.pid}-${Math.random().toString(16).slice(2)}.db`);
    fs.copyFileSync(sqlitePath, copy);
    return copy;
}

test('(setup) boot pglite + build the SQLite source', async () => {
    try {
        sqlitePath = buildSqliteFixture();
    } catch (e) {
        sqliteUsable = false;
        console.warn(`better-sqlite3 unavailable: ${e.message}`);
    }
    const { PGlite } = require('@electric-sql/pglite');
    pg = new PGlite();
    await pg.exec("SET TIME ZONE 'UTC'");
    await pg.exec(`
        CREATE TABLE studio_apps (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
            name TEXT, engine TEXT NOT NULL DEFAULT 'sqlite',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    await pg.query(`INSERT INTO studio_apps (id, user_id, name) VALUES ($1,$2,$3)`, [APP, OWNER, 'Migrate me']);
});

test.after(async () => {
    if (pg) await pg.close();
    if (sqlitePath) { try { fs.unlinkSync(sqlitePath); } catch { /* gone */ } }
});

function skipNoSqlite(t) {
    if (!sqliteUsable) { t.skip('better-sqlite3 native binding unavailable'); return true; }
    return false;
}

// ── Pure helpers ────────────────────────────────────────────────────

test('translateComputedExpr rewrites the two SQLite idioms', () => {
    assert.strictEqual(translateComputedExpr("a || char(59) || b"), 'a || chr(59) || b');
    assert.strictEqual(
        translateComputedExpr("rtrim(rtrim(CAST(qty AS TEXT),'0'),'.')"),
        'trim_scale("qty")::text',
        'the REAL-trimming idiom must NOT survive: on NUMERIC it would turn 20 into 2',
    );
    assert.strictEqual(translateComputedExpr('lower(name)'), 'lower(name)', 'portable SQL is left alone');
});

test('coerceForPg types values the way Postgres columns need them', () => {
    const bool = { key: 'done', type: 'bool' };
    const num = { key: 'qty', type: 'number' };
    assert.strictEqual(coerceForPg(1, bool, []), true);
    assert.strictEqual(coerceForPg(0, bool, []), false);
    assert.strictEqual(coerceForPg('true', bool, []), true);
    assert.strictEqual(coerceForPg('12.5', num, []), 12.5);
    const problems = [];
    assert.strictEqual(coerceForPg('not a number', num, problems), null);
    assert.strictEqual(problems.length, 1, 'a junk value is reported, not silently zeroed');
    assert.strictEqual(coerceForPg(null, num, []), null);
});

// ── The migration itself ────────────────────────────────────────────

test('migrates every row, typed, with a working translated computed column', async (t) => {
    if (skipNoSqlite(t)) return;
    await client.query('BEGIN');
    const res = await _migrateOne(deps({ streamBlob: async () => copyFixture() }), { id: APP, user_id: OWNER, name: 'Migrate me', engine: 'sqlite' });
    await client.query('COMMIT');

    assert.strictEqual(res.status, 'migrated');
    assert.deepStrictEqual(res.tables.lines, { sqliteRows: BIG_ROWS, pgRows: BIG_ROWS }, 'batching copies everything exactly once');
    assert.deepStrictEqual(res.tables.notes, { sqliteRows: 1, pgRows: 1 });
    assert.deepStrictEqual(res.degradedComputed, [], 'the template idiom translates cleanly');

    const { rows } = await pg.query(`SELECT pos, name, qty, done, csv_line FROM "app_${APP}"."lines" WHERE id = 'rec_000007'`);
    assert.strictEqual(rows[0].done, true, 'SQLite 1 became a real boolean');
    assert.strictEqual(Number(rows[0].qty), 20);
    // The whole point of translating rather than copying: Postgres computes it.
    assert.strictEqual(rows[0].csv_line, '7;Item 7;20');

    const { rows: flag } = await pg.query(`SELECT engine FROM studio_apps WHERE id = $1`, [APP]);
    assert.strictEqual(flag[0].engine, 'pg', 'the interlock flips inside the same transaction');
});

test('an already-migrated app is skipped, never migrated twice', async (t) => {
    if (skipNoSqlite(t)) return;
    await client.query('BEGIN');
    const res = await _migrateOne(deps(), { id: APP, user_id: OWNER, engine: 'pg' });
    await client.query('ROLLBACK');
    assert.strictEqual(res.status, 'skipped');
    assert.match(res.reason, /already on the pg engine/);
});

test('an untranslatable computed expression degrades to a plain column that KEEPS its values', async (t) => {
    if (skipNoSqlite(t)) return;
    const APP2 = 'app-bbbb2222-cccc-3333-dddd-444444444444';
    await pg.query(`INSERT INTO studio_apps (id, user_id, name) VALUES ($1,$2,$3)`, [APP2, OWNER, 'Odd expr']);

    // strftime() has no Postgres equivalent — the DDL must fail and fall back.
    const oddModel = {
        modelVersion: 1,
        tables: [{
            id: 'tbl_lines1', key: 'lines',
            fields: [
                { id: 'fld_pos111', key: 'pos', type: 'number', subtype: 'integer' },
                { id: 'fld_name11', key: 'name', type: 'text' },
                { id: 'fld_qty111', key: 'qty', type: 'number' },
                { id: 'fld_done11', key: 'done', type: 'bool' },
                { id: 'fld_when11', key: 'when_at', type: 'datetime' },
                {
                    id: 'fld_csv111', key: 'csv_line', type: 'computed',
                    computed: { type: 'text', stored: true, expr: "strftime('%Y', when_at)" },
                },
            ],
        }],
    };

    await client.query('BEGIN');
    const res = await _migrateOne(
        deps({ loadModel: async () => oddModel, streamBlob: async () => copyFixture() }),
        { id: APP2, user_id: OWNER, engine: 'sqlite' },
    );
    await client.query('COMMIT');

    assert.strictEqual(res.status, 'migrated');
    assert.strictEqual(res.degradedComputed.length, 1);
    assert.strictEqual(res.degradedComputed[0].field, 'csv_line');
    // The values SQLite computed still travel — a frozen column beats a lost one.
    const { rows } = await pg.query(`SELECT csv_line FROM "app_${APP2}"."lines" WHERE id = 'rec_000007'`);
    assert.strictEqual(rows[0].csv_line, '7;Item 7;20', 'the materialized SQLite value was copied');
});

test('REFUSES to migrate when the blob is unreadable but metadata says it has bytes', async (t) => {
    if (skipNoSqlite(t)) return;
    // The trap this closes, found on the real stack: object storage looked
    // absent (its client had not been initialised), so every app read as
    // "no blob" → zero rows copied → the count check compared 0 with 0 and
    // PASSED. A whole fleet would have been "migrated" into empty databases.
    const APP4 = 'app-dddd4444-eeee-5555-ffff-666666666666';
    await pg.query(`INSERT INTO studio_apps (id, user_id, name) VALUES ($1,$2,$3)`, [APP4, OWNER, 'Unreadable']);

    await client.query('BEGIN');
    await assert.rejects(
        _migrateOne(deps({ streamBlob: async () => null }), { id: APP4, user_id: OWNER, engine: 'sqlite', db_size: 81920 }),
        /refusing to migrate an app to an empty schema/,
    );
    await client.query('ROLLBACK');

    // An app that genuinely never had a database still migrates (size 0).
    await client.query('BEGIN');
    const res = await _migrateOne(
        deps({ streamBlob: async () => null, loadModel: async () => ({ modelVersion: 1, tables: [{ id: 'tbl_notes1', key: 'notes', fields: [{ id: 'fld_body11', key: 'body', type: 'text' }] }] }) }),
        { id: APP4, user_id: OWNER, engine: 'sqlite', db_size: 0 },
    );
    await client.query('ROLLBACK');
    assert.strictEqual(res.status, 'migrated');
    assert.deepStrictEqual(res.tables.notes, { sqliteRows: 0, pgRows: 0 });
});

test('a dry run leaves Postgres untouched and the app on sqlite', async (t) => {
    if (skipNoSqlite(t)) return;
    const APP3 = 'app-cccc3333-dddd-4444-eeee-555555555555';
    await pg.query(`INSERT INTO studio_apps (id, user_id, name) VALUES ($1,$2,$3)`, [APP3, OWNER, 'Rehearsal']);

    await client.query('BEGIN');
    const res = await _migrateOne(deps({ streamBlob: async () => copyFixture() }), { id: APP3, user_id: OWNER, engine: 'sqlite' }, { dryRun: true });
    await client.query('ROLLBACK');

    assert.strictEqual(res.status, 'dry-run-ok');
    assert.deepStrictEqual(res.tables.lines, { sqliteRows: BIG_ROWS, pgRows: BIG_ROWS }, 'the rehearsal really copied and verified');
    const { rows: schemas } = await pg.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [`app_${APP3}`]);
    assert.strictEqual(schemas.length, 0, 'PG DDL is transactional — the rehearsal leaves NO residue');
    const { rows: flag } = await pg.query(`SELECT engine FROM studio_apps WHERE id = $1`, [APP3]);
    assert.strictEqual(flag[0].engine, 'sqlite', 'and the app is still served by the old engine');
});
