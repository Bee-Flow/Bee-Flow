/**
 * DB-free tests for the shared SQLite-blob engine (H8).
 *
 * DB-free by construction: the engine takes `storage` and `runQuery` through
 * the factory, so no resolve stubbing is needed. Real SQLite work runs against
 * throwaway files in a pid-scoped tmp dir (same native-binding skip pattern as
 * studioAppDbStore.test.js).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { createRecordingDb } = require('../../testUtils/mockDb');
const { createSqliteBlobEngine } = require('./sqliteBlobEngine');

const OWNER = 'owner-A';
const OTHER = 'owner-B';

const uploads = [];   // { key, size, contentType }
const deletes = [];   // key
let storageAvailable = false;
const storage = {
    isAvailable: () => storageAvailable,
    streamFile: async () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; },
    uploadFile: async (key, buf, contentType) => { uploads.push({ key, size: buf.length, contentType }); return {}; },
    deleteFile: async (key) => { deletes.push(key); },
};
const mock = createRecordingDb({ tables: { things: [] } });

function makeEngine(overrides = {}) {
    return createSqliteBlobEngine({
        workDir: path.join(os.tmpdir(), `beeflow-blob-engine-test-${process.pid}`),
        buildKey: (ownerId, id) => `things/${ownerId}/${id}/data.db`,
        metaTable: 'things',
        logPrefix: 'ThingDB',
        entityLabel: 'Thing DB',
        storage,
        runQuery: mock.db.run,
        ...overrides,
    });
}
const engine = makeEngine();

function freshId() { return `thing-${crypto.randomBytes(6).toString('hex')}`; }

// Probe whether the better-sqlite3 native binding actually works in this
// environment (same pattern as studioAppDbStore.test.js).
let sqliteUsable = true;
let probeError = null;
test('(setup) probe sqlite availability', async (_t) => {
    const id = freshId();
    try {
        await engine.exec(OWNER, id, 'SELECT 1');
    } catch (e) {
        sqliteUsable = false;
        probeError = e.message;
    } finally {
        try { await engine.invalidate(id); } catch (_) {}
    }
});
function skipIfNoSqlite(t) {
    if (!sqliteUsable) {
        t.skip(`better-sqlite3 native binding unavailable: ${probeError}`);
        return true;
    }
    return false;
}

// ── Pure pins (run even without the native binding) ─────────────────

test('_normalizeParams pins the shared coercion contract', () => {
    assert.deepStrictEqual(
        engine._normalizeParams([true, false, { a: 1 }, null, undefined]),
        [1, 0, JSON.stringify({ a: 1 }), null, null],
    );
    assert.deepStrictEqual(engine._normalizeParams(undefined), []);
    assert.throws(() => engine._normalizeParams('nope'), /params must be an array/);
});

test('factory fail-fast on missing config', () => {
    assert.throws(() => createSqliteBlobEngine({}), /createSqliteBlobEngine requires/);
    assert.throws(() => createSqliteBlobEngine(), /createSqliteBlobEngine requires/);
});

// ── SQLite-backed behavior ───────────────────────────────────────────

test('trust boundary: exact configured entityLabel, all owner-scoped accessors refuse', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    await engine.exec(OWNER, id, 'CREATE TABLE tb (id INTEGER PRIMARY KEY)');

    await assert.rejects(
        engine.query(OTHER, id, 'SELECT 1 FROM tb'),
        (err) => err.message === 'Thing DB handle owned by another user — refusing to share',
    );
    for (const fn of [
        () => engine.getWriteHandle(OTHER, id),
        () => engine.getReadHandle(OTHER, id),
        () => engine.exec(OTHER, id, 'SELECT 1'),
        () => engine.reset(OTHER, id),
        () => engine.flush(OTHER, id),
        () => engine.sizeBytes(OTHER, id),
    ]) {
        await assert.rejects(fn(), /owned by another user/);
    }
});

test('readonly guard + validateSql pins', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    await engine.exec(OWNER, id, 'CREATE TABLE g (id INTEGER PRIMARY KEY)');

    await assert.rejects(
        engine.query(OWNER, id, "INSERT INTO g (id) VALUES (1)"),
        /refuses to run a statement that mutates/,
    );
    await assert.rejects(engine.exec(OWNER, id, ''), /non-empty string/);
    await assert.rejects(engine.exec(OWNER, id, 'SELECT ' + "'x'".repeat(200_000)), /larger than the 500000-byte limit/);
});

test('flushNow: metadata UPDATE targets metaTable with sha256 + size', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    mock.calls.run.length = 0;

    await engine.exec(OWNER, id, 'CREATE TABLE m (id INTEGER PRIMARY KEY, v TEXT)');
    await engine.exec(OWNER, id, 'INSERT INTO m (v) VALUES (?)', ['x']);
    await engine.flush(OWNER, id);

    const upd = mock.calls.run.find(c =>
        c.sql === 'UPDATE things SET db_sha256 = $1, db_size = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 AND COALESCE(db_sha256, \'\') = $5');
    assert.ok(upd, `flush UPDATE not recorded; got: ${mock.calls.run.map(c => c.sql).join(' | ')}`);
    assert.match(upd.params[0], /^[0-9a-f]{64}$/);
    assert.ok(upd.params[1] > 0);
    assert.strictEqual(upd.params[2], id);
    assert.strictEqual(upd.params[3], OWNER);
    // The gate baseline: a never-flushed entity matches the '' (or NULL) row.
    assert.strictEqual(upd.params[4], '');
});

test('sha256-gated upload + buildKey routing + reset zeroing UPDATE', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => { storageAvailable = false; return engine.invalidate(id); });
    mock.calls.run.length = 0;
    uploads.length = 0;
    deletes.length = 0;
    storageAvailable = true;

    await engine.exec(OWNER, id, 'CREATE TABLE u (id INTEGER PRIMARY KEY)');
    await engine.flush(OWNER, id);

    const up = uploads.at(-1);
    assert.ok(up, 'upload not recorded');
    assert.strictEqual(up.key, `things/${OWNER}/${id}/data.db`);
    assert.strictEqual(up.contentType, 'application/vnd.sqlite3');
    const upd = mock.calls.run.find(c => c.sql.startsWith('UPDATE things SET db_sha256 = $1'));
    assert.strictEqual(up.size, upd.params[1], 'uploaded byte size must equal recorded db_size');

    await engine.reset(OWNER, id);
    assert.ok(deletes.includes(`things/${OWNER}/${id}/data.db`));
    const zero = mock.calls.run.find(c =>
        c.sql === "UPDATE things SET db_sha256 = '', db_size = 0, updated_at = NOW() WHERE id = $1 AND user_id = $2");
    assert.ok(zero, 'reset zeroing UPDATE not recorded');
    assert.deepStrictEqual(zero.params, [id, OWNER]);
});

test('two engine instances are fully isolated (state + metaTable)', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const idA = freshId();
    const idB = freshId();
    const engineB = makeEngine({
        metaTable: 'others',
        entityLabel: 'Other DB',
        logPrefix: 'OtherDB',
        workDir: path.join(os.tmpdir(), `beeflow-blob-engine-test-B-${process.pid}`),
    });
    t.after(() => Promise.all([engine.invalidate(idA), engineB.invalidate(idB)]));
    mock.calls.run.length = 0;

    await engine.exec(OWNER, idA, 'CREATE TABLE i (id INTEGER PRIMARY KEY)');
    assert.strictEqual(engine._handles.has(idA), true);
    assert.strictEqual(engineB._handles.size, 0, 'instance B must not see instance A handles');

    await engineB.exec(OWNER, idB, 'CREATE TABLE i (id INTEGER PRIMARY KEY)');
    await engineB.flush(OWNER, idB);
    const upd = mock.calls.run.find(c => c.sql.startsWith('UPDATE others SET db_sha256'));
    assert.ok(upd, 'instance B flush must UPDATE its own metaTable');

    // cross-instance trust label
    await assert.rejects(
        engineB.exec(OTHER, idB, 'SELECT 1'),
        (err) => err.message === 'Other DB handle owned by another user — refusing to share',
    );
});

// ── B0 hotfixes: coalescing, flush debounce ceiling, sha gate ───────

test('cold-start coalescing: concurrent opens share ONE download', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    let downloadAttempts = 0;
    const countingStorage = {
        ...storage,
        isAvailable: () => true,
        streamFile: async () => {
            downloadAttempts++;
            await new Promise(r => setTimeout(r, 20)); // hold the window open
            const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e;
        },
    };
    const eng = makeEngine({
        storage: countingStorage,
        workDir: path.join(os.tmpdir(), `beeflow-blob-engine-test-C-${process.pid}`),
    });
    t.after(() => eng.invalidate(id));

    const [a, b, c] = await Promise.all([
        eng.getReadHandle(OWNER, id),
        eng.getReadHandle(OWNER, id),
        eng.getWriteHandle(OWNER, id),
    ]);
    assert.strictEqual(downloadAttempts, 1, 'concurrent misses must share one download');
    assert.strictEqual(a, b, 'coalesced waiters get the same entry');
    assert.strictEqual(b, c);
    // A different owner arriving mid-flight is refused, exactly like a cached hit.
    await assert.rejects(eng.getReadHandle(OTHER, id), /owned by another user/);
});

test('scheduleFlush: a pending timer is NOT reset by later writes (no starvation)', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    await engine.exec(OWNER, id, 'CREATE TABLE s (id INTEGER PRIMARY KEY)');
    const entry = engine._handles.get(id);
    const timer = entry.flushTimer;
    assert.ok(timer, 'first write schedules a flush');
    await engine.exec(OWNER, id, 'INSERT INTO s (id) VALUES (1)');
    assert.strictEqual(entry.flushTimer, timer,
        'a later write must not reset the pending timer — resetting starved the flush under steady writes');
    assert.strictEqual(entry.dirty, true);
});

test('sha gate: unchanged content skips the upload entirely', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    const gateUploads = [];
    const eng = makeEngine({
        storage: { ...storage, isAvailable: () => true, uploadFile: async (key, _buf) => { gateUploads.push(key); return {}; } },
        // Gate always matches: the row exists and carries whatever we last wrote.
        runQuery: async (sql) => (/^UPDATE/.test(sql) ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }),
        workDir: path.join(os.tmpdir(), `beeflow-blob-engine-test-G-${process.pid}`),
    });
    t.after(() => eng.invalidate(id));

    await eng.exec(OWNER, id, 'CREATE TABLE sg (id INTEGER PRIMARY KEY)');
    await eng.flush(OWNER, id);
    assert.strictEqual(gateUploads.length, 1, 'first flush uploads');

    // Nothing changed on disk: a re-flush must not re-upload 256 MB for fun.
    eng._handles.get(id).dirty = true;
    await eng.flush(OWNER, id);
    assert.strictEqual(gateUploads.length, 1, 'unchanged sha skips the upload');
});

test('sha gate: a PROVEN foreign sha poisons the handle; writes then refuse', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    let selects = 0;
    const eng = makeEngine({
        storage: { ...storage, isAvailable: () => false },
        runQuery: async (sql) => {
            if (/^SELECT db_sha256/.test(sql)) {
                selects++;
                // Cold open sees sha A; the post-gate check sees sha B — the
                // row provably moved under us (another replica flushed).
                return { rows: [{ db_sha256: (selects === 1 ? 'a' : 'b').repeat(64) }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 }; // the conditional UPDATE misses
        },
        workDir: path.join(os.tmpdir(), `beeflow-blob-engine-test-P-${process.pid}`),
    });
    t.after(() => eng.invalidate(id));

    await eng.exec(OWNER, id, 'CREATE TABLE pz (id INTEGER PRIMARY KEY)');
    await assert.rejects(eng.flush(OWNER, id), /modified by another replica — refusing to overwrite/);

    const entry = eng._handles.get(id);
    assert.strictEqual(entry.poisoned, true);
    await assert.rejects(eng.exec(OWNER, id, 'INSERT INTO pz (id) VALUES (1)'), /refresh required/);
    await assert.rejects(eng.batch(OWNER, id, [{ sql: 'SELECT 1' }]), /refresh required/);
    await assert.rejects(eng.applyMigration(OWNER, id, ['CREATE TABLE nope (id INTEGER)']), /refresh required/);
    // Reads still serve (stale, but safe) and shutdown must not throw.
    const r = await eng.query(OWNER, id, 'SELECT COUNT(*) AS n FROM pz');
    assert.strictEqual(r.rows[0].n, 0);
    await eng.closeAll();
});

test('sha gate: a MISSING metadata row stays benign (upload proceeds, no poison)', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    const benignUploads = [];
    const eng = makeEngine({
        storage: { ...storage, isAvailable: () => true, uploadFile: async (key) => { benignUploads.push(key); return {}; } },
        // Row never exists: UPDATE misses AND the check SELECT returns nothing.
        runQuery: async () => ({ rows: [], rowCount: 0 }),
        workDir: path.join(os.tmpdir(), `beeflow-blob-engine-test-M-${process.pid}`),
    });
    t.after(() => eng.invalidate(id));

    await eng.exec(OWNER, id, 'CREATE TABLE bn (id INTEGER PRIMARY KEY)');
    await eng.flush(OWNER, id);
    assert.strictEqual(benignUploads.length, 1, 'missing row keeps the old fire-and-forget upload');
    assert.strictEqual(eng._handles.get(id).poisoned, false);
});

test('param typing round-trip (booleans, objects)', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    await engine.exec(OWNER, id, 'CREATE TABLE p (name TEXT, flag INTEGER, blob TEXT)');
    await engine.exec(OWNER, id, 'INSERT INTO p (name, flag, blob) VALUES (?, ?, ?)', ['n', true, { a: 1 }]);
    const res = await engine.query(OWNER, id, 'SELECT name, flag, blob FROM p');
    assert.deepStrictEqual(res.columns, ['name', 'flag', 'blob']);
    assert.strictEqual(res.rows[0].flag, 1, 'boolean true coerces to 1');
    assert.strictEqual(res.rows[0].blob, JSON.stringify({ a: 1 }), 'objects JSON-stringify');
});

test('exec multi-statement + schema introspection', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    const r = await engine.exec(OWNER, id, 'CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (x REAL NOT NULL);');
    assert.strictEqual(r.multi, true);
    const s = await engine.schema(OWNER, id);
    assert.deepStrictEqual(s.tables.map(tb => tb.name), ['a', 'b']);
    const bx = s.tables[1].columns[0];
    assert.strictEqual(bx.type, 'REAL');
    assert.strictEqual(bx.notNull, true);
});

test('batch: mixed read/write, limits', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    await engine.exec(OWNER, id, 'CREATE TABLE bt (id INTEGER PRIMARY KEY, v TEXT)');
    const res = await engine.batch(OWNER, id, [
        { sql: 'INSERT INTO bt (v) VALUES (?)', params: ['one'] },
        { sql: 'INSERT INTO bt (v) VALUES (?)', params: ['two'] },
        { sql: 'SELECT v FROM bt ORDER BY id' },
    ]);
    assert.strictEqual(res[0].changes, 1);
    assert.deepStrictEqual(res[2].rows, [{ v: 'one' }, { v: 'two' }]);
    await assert.rejects(engine.batch(OWNER, id, []), /non-empty statements array/);
    await assert.rejects(
        engine.batch(OWNER, id, Array.from({ length: 501 }, () => ({ sql: 'SELECT 1' }))),
        /at most 500/,
    );
});

test('applyMigration: atomic rollback + empty no-op + limit', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    const ok = await engine.applyMigration(OWNER, id, [
        'CREATE TABLE mg (id INTEGER PRIMARY KEY)',
        'CREATE TABLE mg2 (id INTEGER PRIMARY KEY)',
    ]);
    assert.deepStrictEqual(ok, { applied: 2 });

    await assert.rejects(engine.applyMigration(OWNER, id, [
        'CREATE TABLE should_not_exist (id INTEGER PRIMARY KEY)',
        'THIS IS NOT VALID SQL',
    ]));
    const s = await engine.schema(OWNER, id);
    assert.ok(!s.tables.some(tb => tb.name === 'should_not_exist'), 'partial migration rolled back');

    assert.deepStrictEqual(await engine.applyMigration(OWNER, id, []), { applied: 0 });
    await assert.rejects(
        engine.applyMigration(OWNER, id, Array.from({ length: 501 }, () => 'SELECT 1')),
        /at most 500/,
    );
});

test('sizeBytes: >0 after write, 0 for unknown id', async (t) => {
    if (skipIfNoSqlite(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    await engine.exec(OWNER, id, 'CREATE TABLE sz (id INTEGER PRIMARY KEY)');
    assert.ok(await engine.sizeBytes(OWNER, id) > 0);
    assert.strictEqual(await engine.sizeBytes(OWNER, 'thing-does-not-exist'), 0);
});
