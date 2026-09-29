/**
 * Studio App DB Store — per-app SQLite engine tests (App Studio v2 DATA ENGINE).
 *
 * Exercises query / exec / batch / schema / applyMigration / sizeBytes / reset
 * plus the readonly-enforcement and cross-user trust-boundary refusals. The
 * store is MODULE-INTERNAL — these entry points are only ever called from the
 * data-model layer, never a route with client SQL — so the tests drive them the
 * way that layer would.
 *
 * '../db' and './storageStore' are mocked so the suite is side-effect free (no
 * Postgres, no RustFS): flush only records the metadata UPDATE, and RustFS is
 * reported unavailable so nothing is uploaded/downloaded. The SQLite work is
 * real (a throwaway local file per app). Tests SKIP — not fail — when the
 * better-sqlite3 native binding can't load (Node-ABI mismatch), same as
 * webpageDbStore.paramTypes.test.js.
 *
 * Run: node --test stores/studioAppDbStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.STUDIO_APP_DB_WORK_DIR = path.join(os.tmpdir(), `beeflow-studio-db-test-${process.pid}`);

// ── Mocks for '../db' and './storageStore' ─────────────────────────
const dbCalls = { run: [] };
const mockDb = {
    run: async (sql, params = []) => { dbCalls.run.push({ sql, params }); return { rowCount: 1 }; },
};
const mockStorage = {
    isAvailable: () => false,
    buildStudioAppKey: (ownerId, appId) => `studio-apps/${ownerId}/${appId}/data.db`,
    streamFile: async () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; },
    uploadFile: async () => ({}),
    deleteFile: async () => undefined,
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    if (request === './storageStore') return 'mock-storage';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };
require.cache['mock-storage'] = { id: 'mock-storage', exports: mockStorage };

const store = require('./studioAppDbStore');

const OWNER = 'owner-A';
const OTHER = 'owner-B';
function freshAppId() { return `app-${crypto.randomBytes(6).toString('hex')}`; }

// Probe once whether the native binding is usable; individual tests skip
// cleanly instead of failing on ERR_DLOPEN_FAILED.
let sqliteUsable = true;
let probeError = null;
test('(setup) probe better-sqlite3 native binding availability', async () => {
    const appId = freshAppId();
    try {
        await store.exec(OWNER, appId, 'SELECT 1');
    } catch (err) {
        sqliteUsable = false;
        probeError = err;
    } finally {
        await store.invalidate(appId);
    }
});

const skipIfNoSqlite = (t) =>
    !sqliteUsable && t.skip(`better-sqlite3 native binding unavailable: ${probeError?.message}`);

test('exec + query round-trip with param typing', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));

    await store.exec(OWNER, appId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, blob TEXT)');
    const ins = await store.exec(OWNER, appId, 'INSERT INTO t (name, flag, blob) VALUES (?, ?, ?)', ['x', true, { a: 1 }]);
    assert.strictEqual(ins.changes, 1);

    const { rows, columns } = await store.query(OWNER, appId, 'SELECT name, flag, blob FROM t WHERE id = ?', [ins.lastInsertRowid]);
    assert.strictEqual(rows[0].name, 'x');
    assert.strictEqual(rows[0].flag, 1, 'boolean true coerces to 1');
    assert.strictEqual(rows[0].blob, JSON.stringify({ a: 1 }), 'objects JSON-stringify');
    assert.deepStrictEqual(columns, ['name', 'flag', 'blob']);
});

test('query() refuses a mutating statement (readonly enforcement)', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));
    await store.exec(OWNER, appId, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await assert.rejects(
        () => store.query(OWNER, appId, "INSERT INTO t (id) VALUES (1)"),
        /refuses to run a statement that mutates/,
    );
});

test('exec() runs a multi-statement DDL script', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));
    const r = await store.exec(OWNER, appId, 'CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);');
    assert.strictEqual(r.multi, true);
    const sc = await store.schema(OWNER, appId);
    assert.deepStrictEqual(sc.tables.map(t => t.name).sort(), ['a', 'b']);
});

test('batch() runs mixed read/write in one transaction; enforces limits', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));
    await store.exec(OWNER, appId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const res = await store.batch(OWNER, appId, [
        { sql: 'INSERT INTO t (id, v) VALUES (?, ?)', params: [1, 'a'] },
        { sql: 'INSERT INTO t (id, v) VALUES (?, ?)', params: [2, 'b'] },
        { sql: 'SELECT id, v FROM t ORDER BY id' },
    ]);
    assert.strictEqual(res[0].changes, 1);
    assert.deepStrictEqual(res[2].rows, [{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);

    await assert.rejects(() => store.batch(OWNER, appId, []), /non-empty statements array/);
    const tooMany = Array.from({ length: 501 }, () => ({ sql: 'SELECT 1' }));
    await assert.rejects(() => store.batch(OWNER, appId, tooMany), /at most 500/);
});

test('schema() introspects tables + columns', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));
    await store.exec(OWNER, appId, 'CREATE TABLE t (id TEXT PRIMARY KEY, n REAL NOT NULL)');
    const sc = await store.schema(OWNER, appId);
    const tbl = sc.tables.find(x => x.name === 't');
    assert.ok(tbl);
    const idCol = tbl.columns.find(c => c.name === 'id');
    assert.strictEqual(idCol.primaryKey, true);
    const nCol = tbl.columns.find(c => c.name === 'n');
    assert.strictEqual(nCol.notNull, true);
    assert.strictEqual(nCol.type, 'REAL');
});

test('applyMigration runs ordered DDL atomically and rolls back on failure', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));
    await store.exec(OWNER, appId, 'CREATE TABLE base (id TEXT PRIMARY KEY)');

    // Happy path: two statements apply.
    const ok = await store.applyMigration(OWNER, appId, [
        'ALTER TABLE base ADD COLUMN a TEXT',
        'CREATE TABLE more (id TEXT)',
    ]);
    assert.strictEqual(ok.applied, 2);
    let sc = await store.schema(OWNER, appId);
    assert.ok(sc.tables.find(x => x.name === 'more'));

    // Atomic rollback: the first statement's effect must not survive the failure.
    await assert.rejects(() => store.applyMigration(OWNER, appId, [
        'CREATE TABLE should_not_exist (id TEXT)',
        'THIS IS NOT VALID SQL',
    ]));
    sc = await store.schema(OWNER, appId);
    assert.ok(!sc.tables.find(x => x.name === 'should_not_exist'), 'partial migration rolled back');

    assert.deepStrictEqual(await store.applyMigration(OWNER, appId, []), { applied: 0, skipped: [] }, 'empty plan is a no-op');
});

test('applyMigration stamps PRAGMA user_version inside the migration transaction', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));

    assert.strictEqual(await store.getSchemaStamp(OWNER, appId), 0, 'fresh db starts unstamped');

    await store.applyMigration(OWNER, appId, ['CREATE TABLE t (id TEXT PRIMARY KEY)'], { targetVersion: 1 });
    assert.strictEqual(await store.getSchemaStamp(OWNER, appId), 1);

    // An empty plan with a targetVersion still stamps (model-only saves).
    assert.deepStrictEqual(
        await store.applyMigration(OWNER, appId, [], { targetVersion: 2 }),
        { applied: 0, skipped: [] },
    );
    assert.strictEqual(await store.getSchemaStamp(OWNER, appId), 2);

    // A failing plan rolls the stamp back with the DDL (same transaction).
    await assert.rejects(() => store.applyMigration(OWNER, appId, [
        'CREATE TABLE should_not_exist (id TEXT)',
        'THIS IS NOT VALID SQL',
    ], { targetVersion: 9 }));
    assert.strictEqual(await store.getSchemaStamp(OWNER, appId), 2, 'stamp rolled back on failure');
    const sc = await store.schema(OWNER, appId);
    assert.ok(!sc.tables.find(x => x.name === 'should_not_exist'), 'DDL rolled back too');

    // Non-integer / negative targetVersion is ignored, not stamped.
    await store.applyMigration(OWNER, appId, ['CREATE TABLE u (id TEXT)'], { targetVersion: -1 });
    assert.strictEqual(await store.getSchemaStamp(OWNER, appId), 2);
});

test('applyMigration tolerates a replayed plan (already-applied signatures skipped)', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));

    const plan = [
        'CREATE TABLE IF NOT EXISTS "tasks" (id TEXT PRIMARY KEY, title TEXT)',
        'ALTER TABLE "tasks" ADD COLUMN "done" INTEGER',
        'ALTER TABLE "tasks" RENAME COLUMN "title" TO "subject"',
    ];
    const first = await store.applyMigration(OWNER, appId, plan, { targetVersion: 1 });
    assert.strictEqual(first.applied, 3);
    assert.deepStrictEqual(first.skipped, []);

    // The Postgres-commit-failed retry: same plan, next stamp — succeeds.
    const replay = await store.applyMigration(OWNER, appId, plan, { targetVersion: 1 });
    assert.deepStrictEqual(
        replay.skipped.map(s => s.reason).sort(),
        ['column already added', 'column already renamed'],
    );
    assert.strictEqual(await store.getSchemaStamp(OWNER, appId), 1);

    // A genuinely broken statement still throws through the tolerant path.
    await assert.rejects(() => store.applyMigration(OWNER, appId, ['ALTER TABLE "ghost" ADD COLUMN "x" TEXT']));
});

test('sizeBytes reports the materialised db size', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));
    await store.exec(OWNER, appId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const size = await store.sizeBytes(OWNER, appId);
    assert.ok(size > 0, 'db file has non-zero size after a write');
    assert.strictEqual(await store.sizeBytes(OWNER, freshAppId()), 0, 'unknown app → 0');
});

test('cross-user trust boundary: a foreign owner is refused', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));
    await store.exec(OWNER, appId, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');

    // Raw handles are no longer exported (frozen facade seam) — every path to
    // the database goes through the contract methods, all owner-checked.
    assert.strictEqual(store.getWriteHandle, undefined, 'raw write handle must not leak');
    assert.strictEqual(store.getReadHandle, undefined, 'raw read handle must not leak');
    await assert.rejects(() => store.getSchemaStamp(OTHER, appId), /owned by another user/);
    await assert.rejects(() => store.query(OTHER, appId, 'SELECT 1 FROM t'), /owned by another user/);
    await assert.rejects(() => store.exec(OTHER, appId, 'INSERT INTO t VALUES (9)'), /owned by another user/);
    await assert.rejects(() => store.reset(OTHER, appId), /owned by another user/);
    await assert.rejects(() => store.flush(OTHER, appId), /owned by another user/);
    await assert.rejects(() => store.sizeBytes(OTHER, appId), /owned by another user/);
});

test('reset zeroes the studio_apps metadata (owner-scoped UPDATE)', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    await store.exec(OWNER, appId, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');
    dbCalls.run = [];
    await store.reset(OWNER, appId);
    const upd = dbCalls.run.find(c => /UPDATE studio_apps/i.test(c.sql) && /db_sha256\s*=\s*''/.test(c.sql));
    assert.ok(upd, 'reset issues the zeroing UPDATE');
    assert.match(upd.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i, 'reset UPDATE is owner-scoped');
    assert.deepStrictEqual(upd.params, [appId, OWNER]);
});

test('validateSql rejects empty and oversized SQL', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const appId = freshAppId();
    t.after(() => store.invalidate(appId));
    await assert.rejects(() => store.exec(OWNER, appId, ''), /non-empty string/);
    const huge = 'SELECT ' + "'x',".repeat(130_000) + "'x'"; // > 500 KB
    await assert.rejects(() => store.query(OWNER, appId, huge), /larger than the 500000-byte limit/);
});

// ── Pure normalizeParams (no native binding) ────────────────────────
test('_normalizeParams coerces booleans and stringifies objects', () => {
    assert.deepStrictEqual(store._normalizeParams([true, false, { a: 1 }, null, undefined]),
        [1, 0, JSON.stringify({ a: 1 }), null, null]);
    assert.deepStrictEqual(store._normalizeParams(undefined), []);
    assert.throws(() => store._normalizeParams('nope'), /params must be an array/);
});
