/**
 * Postgres app-data engine — facade-contract tests (wave B2), backed by a REAL
 * Postgres: @electric-sql/pglite (in-memory WASM PG 18) behind tiny adapters
 * that present node-pg result shapes ({ rows, fields, rowCount, command })
 * through the engine's injected runQuery/getClient seam.
 *
 * Proves the load-bearing pieces:
 *   • ownership refusal (same message shape as the sqlite engine) and the
 *     studio_apps.engine INTERLOCK ({ code:'engine_mismatch', status:503 });
 *   • per-statement SAVEPOINT tolerance in applyMigration (42701/42P07 skip,
 *     anything else aborts the WHOLE plan) + schema-stamp atomicity;
 *   • caller-owned-transaction applyMigration({ client }) never commits;
 *   • pg error mapping: unique violation → 409 naming the field id parsed from
 *     uq_<tableId>_<fieldId>; FK → 422; bad cast → 422;
 *   • query() is enforced read-only by the transaction itself;
 *   • wire-format normalization (NUMERIC/BIGINT → number, DATE → 'YYYY-MM-DD',
 *     TIMESTAMPTZ → ISO, BOOLEAN stays boolean);
 *   • schema() / sizeBytes() (+ db_size mirror) / reset() / getSchemaStamp().
 *
 * Run: cd server && node --test stores/lib/pgAppEngine.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { createPgAppEngine } = require('./pgAppEngine');
const engineFlag = require('../../appStudio/engineFlag');
const dm = require('../../appStudio/dataModel');

const OWNER = 'owner-A';
const OTHER = 'owner-B';
const APP = 'app-11111111-2222-3333-4444-555555555555';
const APP_SQLITE = 'app-sqlite-legacy';
const APP_FRESH = 'app-fresh-never-migrated';

let pg = null;      // the PGlite instance
let engine = null;  // the engine under test

// ── node-pg-shaped adapters over pglite ─────────────────────────────

function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    // pglite has no `command`; synthesize it the way node-pg would report:
    // row-describing statements are SELECT-shaped, everything else keeps its
    // first keyword. (Real node-pg provides this natively — the ENGINE relies
    // on result.command, only this test adapter reconstructs it.)
    const command = fields.length > 0 ? 'SELECT' : String(sql).trim().split(/\s+/)[0].toUpperCase();
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command };
}

async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adaptResult(await pg.exec(sql), sql);
    return adaptResult(await pg.query(sql), sql);
}

const runQuery = (sql, params) => rawQuery(sql, params);
const getClient = async () => ({
    query: (sql, params) => rawQuery(sql, params),
    release: () => {},
});

// A pg-dialect DDL plan for one simple table (compiled via dataModel with the
// flag flipped, exactly like saveDataModel will under STUDIO_APP_ENGINE=pg).
function pgPlanFor(table) {
    engineFlag._setForTests('pg');
    try {
        return [dm.ddlForTable(table)];
    } finally {
        engineFlag._setForTests(null);
    }
}

const TASKS = {
    id: 'tbl_tasks1',
    key: 'tasks',
    fields: [
        { id: 'fld_title1', key: 'title', type: 'text' },
        { id: 'fld_amount', key: 'amount', type: 'number' },
        { id: 'fld_qty111', key: 'qty', type: 'number', subtype: 'integer' },
        { id: 'fld_due111', key: 'due', type: 'date' },
        { id: 'fld_at1111', key: 'happened_at', type: 'datetime' },
        { id: 'fld_active', key: 'active', type: 'bool' },
    ],
};

test('(setup) boot pglite, studio_apps fixture, engine', async () => {
    const { PGlite } = require('@electric-sql/pglite');
    pg = new PGlite();
    await pg.exec("SET TIME ZONE 'UTC'");
    await pg.exec(`
        CREATE TABLE studio_apps (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            engine TEXT NOT NULL DEFAULT 'sqlite',
            db_sha256 TEXT DEFAULT '',
            db_size BIGINT DEFAULT 0,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    await pg.query(`INSERT INTO studio_apps (id, user_id, engine) VALUES ($1,$2,'pg'), ($3,$4,'sqlite'), ($5,$6,'pg')`,
        [APP, OWNER, APP_SQLITE, OWNER, APP_FRESH, OTHER]);
    engine = createPgAppEngine({
        runQuery,
        getClient,
        logPrefix: 'StudioAppDB',
        entityLabel: 'Studio App DB',
        schemaFor: (appId) => 'app_' + appId,
    });
});

test.after(async () => { if (pg) await pg.close(); });

// ── Trust boundary + interlock ──────────────────────────────────────

test('a different ownerId is refused with the sqlite engine\'s message shape', async () => {
    await assert.rejects(
        () => engine.query(OTHER, APP, 'SELECT 1 AS one'),
        /Studio App DB handle owned by another user — refusing to share/,
    );
});

test('engine interlock: an app marked engine=sqlite is refused with engine_mismatch', async () => {
    await assert.rejects(
        () => engine.query(OWNER, APP_SQLITE, 'SELECT 1 AS one'),
        (err) => {
            assert.strictEqual(err.code, 'engine_mismatch');
            assert.strictEqual(err.status, 503);
            return true;
        },
    );
    // exec and batch go through the same gate
    await assert.rejects(() => engine.exec(OWNER, APP_SQLITE, 'SELECT 1'), /engine_mismatch/);
    await assert.rejects(() => engine.batch(OWNER, APP_SQLITE, [{ sql: 'SELECT 1' }]), /engine_mismatch/);
});

test('an unknown app id is a 404, not a silent empty database', async () => {
    await assert.rejects(
        () => engine.query(OWNER, 'app-does-not-exist', 'SELECT 1'),
        (err) => err.status === 404 && /not found/.test(err.message),
    );
});

// ── Migration: schema creation, stamp, savepoint tolerance ──────────

test('applyMigration materialises the schema + tables and stamps the schema stamp atomically', async () => {
    const res = await engine.applyMigration(OWNER, APP, pgPlanFor(TASKS), { targetVersion: 3 });
    assert.strictEqual(res.applied, 1);
    assert.deepStrictEqual(res.skipped, []);
    assert.strictEqual(await engine.getSchemaStamp(OWNER, APP), 3);

    const sc = await engine.schema(OWNER, APP);
    const tasks = sc.tables.find(t => t.name === 'tasks');
    assert.ok(tasks, 'tasks table exists in the app schema');
    assert.ok(!sc.tables.some(t => t.name === '_meta'), '_meta is engine metadata, not app schema');
    const id = tasks.columns.find(c => c.name === 'id');
    assert.strictEqual(id.primaryKey, true);
    assert.strictEqual(id.notNull, true);
    assert.strictEqual(tasks.columns.find(c => c.name === 'active').type, 'BOOLEAN');
    assert.strictEqual(tasks.columns.find(c => c.name === 'qty').type, 'BIGINT');
});

test('getSchemaStamp is 0 for a never-migrated app (no schema, no _meta)', async () => {
    assert.strictEqual(await engine.getSchemaStamp(OTHER, APP_FRESH), 0);
});

test('replaying a plan skips 42701/42P07 via savepoints and reports them', async () => {
    const plan = [
        'CREATE TABLE plain_t (id TEXT PRIMARY KEY)',
        'ALTER TABLE plain_t ADD COLUMN c1 TEXT',
    ];
    const first = await engine.applyMigration(OWNER, APP, plan, { targetVersion: 4 });
    assert.strictEqual(first.applied, 2);

    const replay = await engine.applyMigration(OWNER, APP, plan, { targetVersion: 5 });
    assert.strictEqual(replay.applied, 0);
    assert.deepStrictEqual(replay.skipped.map(s => s.reason),
        ['table or index already created', 'column already added']);
    // the stamp still advanced in the same (otherwise skipped) transaction
    assert.strictEqual(await engine.getSchemaStamp(OWNER, APP), 5);
});

test('a real migration error aborts the WHOLE plan (earlier statements roll back)', async () => {
    await assert.rejects(
        () => engine.applyMigration(OWNER, APP, [
            'CREATE TABLE doomed_t (id TEXT PRIMARY KEY)',
            'ALTER TABLE missing_zzz ADD COLUMN x TEXT', // 42P01 — NOT tolerated
        ], { targetVersion: 6 }),
    );
    const sc = await engine.schema(OWNER, APP);
    assert.ok(!sc.tables.some(t => t.name === 'doomed_t'), 'first statement rolled back with the failure');
    assert.strictEqual(await engine.getSchemaStamp(OWNER, APP), 5, 'stamp did not advance');
});

test('applyMigration({ client }) runs on the caller\'s transaction and never commits it', async () => {
    const client = await getClient();
    await client.query('BEGIN');
    const res = await engine.applyMigration(OWNER, APP, ['CREATE TABLE ephemeral_t (id TEXT)'], { client });
    assert.strictEqual(res.applied, 1);
    await client.query('ROLLBACK');
    client.release();
    const sc = await engine.schema(OWNER, APP);
    assert.ok(!sc.tables.some(t => t.name === 'ephemeral_t'),
        'caller rolled back → nothing persisted, so the engine did not COMMIT for them');
});

test('applyMigration({ client }) hands the search path back to its caller', async () => {
    // THE BUG THIS PINS: applyMigration narrows search_path to the app schema
    // with SET LOCAL, which lives until the CALLER's commit. saveDataModel then
    // writes its own row in a PUBLIC table on that same transaction — and could
    // not find it. Saving a data model on Postgres failed outright: installing
    // a template, adding a table, adding a column. Found by installing a
    // template on the local pg stack, not by any unit test, because every test
    // that passed { client } only ever looked inside the app schema afterwards.
    const client = await getClient();
    await client.query('BEGIN');
    // A public table standing in for studio_app_data_meta.
    await client.query('CREATE TABLE IF NOT EXISTS public.after_migration_probe (id TEXT)');

    await engine.applyMigration(OWNER, APP, ['CREATE TABLE IF NOT EXISTS sp_probe_t (id TEXT)'], { client });

    // Unqualified, exactly as the caller writes it.
    await client.query("INSERT INTO after_migration_probe (id) VALUES ('ok')");
    const seen = await client.query('SELECT count(*)::int AS n FROM after_migration_probe');
    assert.strictEqual(seen.rows[0].n, 1, 'the caller can still reach its own public tables');

    await client.query('ROLLBACK');
    client.release();
});

// ── exec / query / batch + wire format ──────────────────────────────

test('exec inserts with ? params; query returns normalized wire-format rows', async () => {
    const ins = await engine.exec(OWNER, APP,
        'INSERT INTO "tasks" ("id", "created_at", "updated_at", "created_by", "org_id", "title", "amount", "qty", "due", "happened_at", "active") '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['rec_1', '2026-03-14T10:00:00.000Z', '2026-03-14T10:00:00.000Z', OWNER, 'org-1',
            'first', 10.5, 42, '2026-03-14', '2026-03-14T10:30:00.000Z', true]);
    assert.deepStrictEqual(ins, { changes: 1 });

    const res = await engine.query(OWNER, APP, 'SELECT * FROM "tasks" WHERE "id" = ?', ['rec_1']);
    assert.strictEqual(res.truncated, false);
    assert.ok(res.columns.includes('title') && res.columns.includes('amount'), 'columns from result.fields');
    const row = res.rows[0];
    assert.strictEqual(row.amount, 10.5, 'NUMERIC comes back as a number, not "10.5"');
    assert.strictEqual(row.qty, 42, 'BIGINT comes back as a number');
    assert.strictEqual(row.due, '2026-03-14', 'DATE comes back as the calendar day, not a shifted Date');
    assert.strictEqual(row.happened_at, '2026-03-14T10:30:00.000Z', 'TIMESTAMPTZ comes back as ISO text');
    assert.strictEqual(row.active, true, 'BOOLEAN stays a boolean');
});

test('query() is read-only — a mutation through it is refused by the transaction', async () => {
    await assert.rejects(
        () => engine.query(OWNER, APP, `DELETE FROM "tasks" WHERE "id" = ?`, ['rec_1']),
        /refuses to run a statement that mutates the database — use exec\(\) instead/,
    );
    const still = await engine.query(OWNER, APP, 'SELECT count(*) AS n FROM "tasks"');
    assert.strictEqual(still.rows[0].n, 1);
});

test('exec with no params runs a multi-statement DDL script in the app schema', async () => {
    const r = await engine.exec(OWNER, APP, 'CREATE TABLE m1 (id TEXT); CREATE TABLE m2 (id TEXT);');
    assert.deepStrictEqual(r, { changes: 0, multi: true });
    const sc = await engine.schema(OWNER, APP);
    assert.ok(sc.tables.some(t => t.name === 'm1') && sc.tables.some(t => t.name === 'm2'));
});

test('batch runs everything in ONE transaction with per-statement shapes', async () => {
    const results = await engine.batch(OWNER, APP, [
        { sql: 'INSERT INTO "tasks" ("id", "title", "amount") VALUES (?, ?, ?)', params: ['rec_2', 'second', 20] },
        { sql: 'SELECT "id", "title" FROM "tasks" ORDER BY "id"' },
        { sql: 'UPDATE "tasks" SET "title" = ? WHERE "id" = ?', params: ['second!', 'rec_2'] },
    ]);
    assert.deepStrictEqual(results[0], { changes: 1 });
    assert.deepStrictEqual(results[1].rows.map(r => r.id), ['rec_1', 'rec_2']);
    assert.deepStrictEqual(results[2], { changes: 1 });

    // atomicity: a failing statement rolls back the earlier ones
    await assert.rejects(() => engine.batch(OWNER, APP, [
        { sql: 'INSERT INTO "tasks" ("id", "title") VALUES (?, ?)', params: ['rec_3', 'doomed'] },
        { sql: 'INSERT INTO "tasks" ("id", "title") VALUES (?, ?)', params: ['rec_1', 'pk clash'] },
    ]));
    const after = await engine.query(OWNER, APP, 'SELECT count(*) AS n FROM "tasks"');
    assert.strictEqual(after.rows[0].n, 2, 'rec_3 rolled back with the failure');
});

// ── Error mapping ───────────────────────────────────────────────────

test('unique violation maps to 409 unique_violation naming the field from uq_<tbl>_<fld>', async () => {
    await engine.applyMigration(OWNER, APP, [
        'CREATE TABLE uniq_t (id TEXT PRIMARY KEY, sku TEXT)',
        'CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_tasks1_fld_sku99" ON uniq_t (sku)',
    ]);
    await engine.exec(OWNER, APP, 'INSERT INTO uniq_t (id, sku) VALUES (?, ?)', ['a', 'S-1']);
    await assert.rejects(
        () => engine.exec(OWNER, APP, 'INSERT INTO uniq_t (id, sku) VALUES (?, ?)', ['b', 'S-1']),
        (err) => {
            assert.strictEqual(err.status, 409);
            assert.strictEqual(err.code, 'unique_violation');
            // The SENTENCE names the column the person typed into, read from
            // Postgres's DETAIL. `fld_sku99` is the model's internal id and
            // means nothing to anybody reading the response — it stays on the
            // error object for programmatic use and out of the message.
            assert.match(err.message, /"sku"/, 'message names the human column');
            assert.doesNotMatch(err.message, /fld_/, 'an internal field id is not an explanation');
            assert.strictEqual(err.column, 'sku');
            assert.strictEqual(err.fieldId, 'fld_sku99');
            assert.strictEqual(err.tableId, 'tbl_tasks1');
            return true;
        },
    );
});

test('foreign-key violation maps to 422 relation_violation', async () => {
    await engine.exec(OWNER, APP,
        'CREATE TABLE parent_t (id TEXT PRIMARY KEY); CREATE TABLE child_t (id TEXT PRIMARY KEY, parent TEXT REFERENCES parent_t(id));');
    await assert.rejects(
        () => engine.exec(OWNER, APP, 'INSERT INTO child_t (id, parent) VALUES (?, ?)', ['c1', 'nope']),
        (err) => err.status === 422 && err.code === 'relation_violation',
    );
});

test('a missing required value maps to 422 required_value naming the column', async () => {
    await engine.applyMigration(OWNER, APP, [
        'CREATE TABLE notnull_t (id TEXT PRIMARY KEY, email TEXT NOT NULL)',
    ]);
    await assert.rejects(
        () => engine.exec(OWNER, APP, 'INSERT INTO notnull_t (id) VALUES (?)', ['a']),
        (err) => {
            assert.strictEqual(err.status, 422, '23502 used to fall through to a bare 500');
            assert.strictEqual(err.code, 'required_value');
            assert.match(err.message, /"email"/, 'the sentence names the column the person left empty');
            assert.strictEqual(err.column, 'email');
            return true;
        },
    );
});

test('ADD COLUMN … NOT NULL on a populated table is the same 422, not a 500', async () => {
    // The second way into 23502, and the one a schema save hits: the model
    // grows a required column while rows already exist. Without the mapping the
    // owner got "Could not save the columns" and no idea which column.
    await engine.exec(OWNER, APP, 'INSERT INTO notnull_t (id, email) VALUES (?, ?)', ['b', 'x@y.z']);
    await assert.rejects(
        () => engine.applyMigration(OWNER, APP, [
            'ALTER TABLE notnull_t ADD COLUMN "vat_number" TEXT NOT NULL',
        ]),
        (err) => {
            assert.strictEqual(err.status, 422);
            assert.strictEqual(err.code, 'required_value');
            assert.match(err.message, /"vat_number"/);
            return true;
        },
    );
});

test('a data exception (SQLSTATE class 22) maps to 422 invalid_value', async () => {
    await assert.rejects(
        () => engine.exec(OWNER, APP, 'INSERT INTO "tasks" ("id", "amount") VALUES (?, ?)', ['rec_bad', 'not-a-number']),
        (err) => err.status === 422 && err.code === 'invalid_value',
    );
});

// ── sizeBytes / reset / caches ──────────────────────────────────────

test('sizeBytes is > 0 once tables exist and mirrors into studio_apps.db_size', async () => {
    const bytes = await engine.sizeBytes(OWNER, APP);
    assert.ok(bytes > 0, `schema has relations → ${bytes} bytes`);
    assert.ok(engine._sizeCache.has(APP), '30s TTL cache populated');
    await new Promise(r => setTimeout(r, 25)); // let the fire-and-forget mirror land
    const row = await rawQuery('SELECT db_size FROM studio_apps WHERE id = $1', [APP]);
    assert.strictEqual(Number(row.rows[0].db_size), bytes);
});

test('invalidate drops the cached ownership facts so interlock flips take effect', async () => {
    await rawQuery(`UPDATE studio_apps SET engine = 'sqlite' WHERE id = $1`, [APP]);
    // cached facts still say 'pg' — the 60s cache serves them
    await engine.query(OWNER, APP, 'SELECT 1 AS one');
    await engine.invalidate(APP);
    await assert.rejects(() => engine.query(OWNER, APP, 'SELECT 1 AS one'), /engine_mismatch/);
    await rawQuery(`UPDATE studio_apps SET engine = 'pg' WHERE id = $1`, [APP]);
    await engine.invalidate(APP);
});

test('reset drops the whole app schema and zeroes the size metadata', async () => {
    await engine.reset(OWNER, APP);
    const schemas = await rawQuery('SELECT 1 AS x FROM information_schema.schemata WHERE schema_name = $1', ['app_' + APP]);
    assert.strictEqual(schemas.rows.length, 0, 'schema dropped (CASCADE)');
    assert.strictEqual(await engine.getSchemaStamp(OWNER, APP), 0, 'stamp gone with the schema');
    const meta = await rawQuery('SELECT db_size, db_sha256 FROM studio_apps WHERE id = $1', [APP]);
    assert.strictEqual(Number(meta.rows[0].db_size), 0);
    assert.strictEqual(meta.rows[0].db_sha256, '');
});

test('flush and closeAll are cheap no-ops (nothing to flush — commits are durability)', async () => {
    await engine.flush(OWNER, APP);
    await engine.closeAll();
    assert.strictEqual(engine._ownershipCache.size, 0);
    assert.strictEqual(engine._sizeCache.size, 0);
});

// ── The studioAppDbStore facade switch (STUDIO_APP_ENGINE=pg) ───────

test('studioAppDbStore wires the pg engine when the flag is set, same surface', async () => {
    process.env.STUDIO_APP_ENGINE = 'pg';
    const Module = require('module');
    const dbPath = require.resolve('../../db');
    const originalResolve = Module._resolveFilename;
    // '../db' as required by studioAppDbStore → this pglite adapter pair.
    require.cache[dbPath] = {
        id: dbPath, filename: dbPath, loaded: true,
        exports: { run: runQuery, getClient },
    };
    try {
        delete require.cache[require.resolve('../studioAppDbStore')];
        const store = require('../studioAppDbStore');
        for (const fn of ['query', 'exec', 'batch', 'applyMigration', 'getSchemaStamp', 'schema',
            'sizeBytes', 'reset', 'flush', 'invalidate', 'closeAll']) {
            assert.strictEqual(typeof store[fn], 'function', `facade exports ${fn}`);
        }
        assert.ok(store._handles instanceof Map, 'test-only surface stays shape-identical');
        // End to end through the facade: migrate + write + read on pglite.
        await store.applyMigration(OWNER, APP, pgPlanFor(TASKS), { targetVersion: 9 });
        assert.strictEqual(await store.getSchemaStamp(OWNER, APP), 9);
        await store.exec(OWNER, APP, 'INSERT INTO "tasks" ("id", "title", "active") VALUES (?, ?, ?)', ['rec_9', 'via facade', true]);
        const res = await store.query(OWNER, APP, 'SELECT "title", "active" FROM "tasks"');
        assert.deepStrictEqual(res.rows, [{ title: 'via facade', active: true }]);
        await store.reset(OWNER, APP);
    } finally {
        Module._resolveFilename = originalResolve;
        delete process.env.STUDIO_APP_ENGINE;
        delete require.cache[require.resolve('../studioAppDbStore')];
        delete require.cache[dbPath];
    }
});

// ── Schema-stamp monotonicity (last: it deliberately leaves the stamp high) ──

test('the schema stamp only ever moves FORWARD, whichever replica finishes last', async () => {
    // Two replicas can apply plans in either order. With EXCLUDED.value the one
    // that finished second stamped the tenant BACKWARDS — the stamp then reads
    // as drift against a model_version that is actually correct, and the repair
    // path built on it re-runs a migration that already landed.
    // reset() ran above, so this app starts from a clean 0.
    assert.strictEqual(await engine.getSchemaStamp(OWNER, APP), 0);
    await engine.applyMigration(OWNER, APP, ['SELECT 1'], { targetVersion: 9 });
    assert.strictEqual(await engine.getSchemaStamp(OWNER, APP), 9);
    await engine.applyMigration(OWNER, APP, ['SELECT 1'], { targetVersion: 4 });
    assert.strictEqual(await engine.getSchemaStamp(OWNER, APP), 9, 'the slow replica must not walk it back');
});

test('a hand-edited, non-numeric stamp does not abort the whole migration', async () => {
    // The GREATEST comparison casts, and a cast failure inside applyMigration's
    // transaction would take a perfectly good DDL plan down with it.
    await engine.exec(OWNER, APP, `UPDATE "_meta" SET value = 'nonsense' WHERE key = 'schema_stamp'`);
    await engine.applyMigration(OWNER, APP, ['SELECT 1'], { targetVersion: 11 });
    assert.strictEqual(await engine.getSchemaStamp(OWNER, APP), 11);
});
