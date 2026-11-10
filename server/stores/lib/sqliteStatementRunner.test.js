/**
 * The statement deadline of the SQLite-blob engine (sqliteStatementRunner.js)
 * and the page ceiling (sqliteOpen.js): a statement that runs past the
 * deadline is stopped and reported as such, the engine keeps working on the
 * same file afterwards, a killed write leaves the file as it was, blobs cross
 * the process boundary intact, and 0 switches the deadline off.
 *
 * Run: cd server && node --test stores/lib/sqliteStatementRunner.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRecordingDb } = require('../../testUtils/mockDb');
const { createSqliteBlobEngine } = require('./sqliteBlobEngine');
const { createStatementRunner, StatementTimeoutError, statementTimeoutMs, DEFAULT_MAX_PROCESSES, DEFAULT_IDLE_MS } = require('./sqliteStatementRunner');
const { maxPageCount, DEFAULT_MAX_PAGE_COUNT } = require('./sqliteOpen');

const OWNER = 'owner-A';
const storage = {
    isAvailable: () => false,
    streamFile: async () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; },
    uploadFile: async () => ({}),
    deleteFile: async () => {},
};
const workDir = path.join(os.tmpdir(), `beeflow-stmt-runner-test-${process.pid}`);

function makeEngine(overrides = {}) {
    return createSqliteBlobEngine({
        workDir,
        buildKey: (ownerId, id) => `things/${ownerId}/${id}/data.db`,
        metaTable: 'things',
        logPrefix: 'ThingDB',
        entityLabel: 'Thing DB',
        storage,
        runQuery: createRecordingDb({ tables: { things: [] } }).db.run,
        ...overrides,
    });
}
const freshId = () => `thing-${crypto.randomBytes(6).toString('hex')}`;

// Two deadlines. A statement that has to COMPLETE (the setup, a follow-up read,
// another owner's statement) runs under GENEROUS_MS, which includes forking its
// statement process: a loaded machine must not be able to fail it. A statement
// that has to be CUT OFF runs under CUTOFF_MS, set on its owner's lane just
// before it is sent, so the stop itself stays quick.
const GENEROUS_MS = 30_000;
const CUTOFF_MS = 300;
/** The deadline of the statements `ownerId` sends from here on. */
const setDeadline = (engine, ownerId, ms) => { engine._runner.laneFor(ownerId).timeoutMs = ms; };

// A query that never finishes on its own: an unbounded recursive count.
const ENDLESS = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c';

test.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

test('a statement past the deadline is stopped, reported, and the engine serves the file again', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const id = freshId();
    await engine.exec(OWNER, id, 'CREATE TABLE t (a)');
    await engine.exec(OWNER, id, 'INSERT INTO t VALUES (1)');

    setDeadline(engine, OWNER, CUTOFF_MS);
    const t0 = Date.now();
    await assert.rejects(engine.query(OWNER, id, ENDLESS), (err) => {
        assert.ok(err instanceof StatementTimeoutError, `${err.name}: ${err.message}`);
        assert.strictEqual(err.code, 'statement_timeout');
        return true;
    });
    assert.ok(Date.now() - t0 < 5000, 'cut off near the deadline, not at the end of the query');

    // A fresh statement process answers, on the same file, with the data intact.
    setDeadline(engine, OWNER, GENEROUS_MS);
    const { rows } = await engine.query(OWNER, id, 'SELECT a FROM t');
    assert.deepStrictEqual(rows, [{ a: 1 }]);
});

test('a write stopped at the deadline leaves the file as it was', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const id = freshId();
    await engine.exec(OWNER, id, 'CREATE TABLE t (a)');
    await engine.exec(OWNER, id, 'INSERT INTO t VALUES (1)');
    // The transaction writes a row and then never ends.
    setDeadline(engine, OWNER, CUTOFF_MS);
    await assert.rejects(
        engine.batch(OWNER, id, [{ sql: 'INSERT INTO t VALUES (2)' }, { sql: ENDLESS }]),
        StatementTimeoutError,
    );
    setDeadline(engine, OWNER, GENEROUS_MS);
    const { rows } = await engine.query(OWNER, id, 'SELECT count(*) AS n FROM t');
    assert.deepStrictEqual(rows, [{ n: 1 }], 'the half-done transaction was rolled back');
});

test('a batch_no_rows failure crosses the process boundary with its statementIndex', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const id = freshId();
    await engine.exec(OWNER, id, 'CREATE TABLE t (a)');
    await assert.rejects(
        engine.batch(OWNER, id, [{ sql: 'INSERT INTO t VALUES (1)' }, { sql: 'UPDATE t SET a = 2 WHERE a = 99', expectChanges: true }]),
        (err) => err.code === 'batch_no_rows' && err.statementIndex === 1,
    );
    const { rows } = await engine.query(OWNER, id, 'SELECT count(*) AS n FROM t');
    assert.deepStrictEqual(rows, [{ n: 0 }]);
});

test('a write in flight when the process is stopped fails with the timeout error', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const id = freshId();
    await engine.exec(OWNER, id, 'CREATE TABLE t (a)');
    setDeadline(engine, OWNER, CUTOFF_MS);
    const results = await Promise.allSettled([
        engine.query(OWNER, id, ENDLESS),
        engine.exec(OWNER, id, 'INSERT INTO t VALUES (1)'),
    ]);
    assert.strictEqual(results[0].status, 'rejected');
    assert.strictEqual(results[1].status, 'rejected');
    assert.ok(results[1].reason instanceof StatementTimeoutError);
});

test('a read of another owner waiting behind a stopped statement is sent again and answers', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const slow = freshId();
    const other = freshId();
    await engine.exec(OWNER, slow, 'CREATE TABLE t (a)');
    await engine.exec('owner-B', other, 'CREATE TABLE u (b)');
    await engine.exec('owner-B', other, 'INSERT INTO u VALUES (7)');
    setDeadline(engine, OWNER, CUTOFF_MS);
    const results = await Promise.allSettled([
        engine.query(OWNER, slow, ENDLESS),
        engine.query('owner-B', other, 'SELECT b FROM u'),
        engine.schema('owner-B', other),
    ]);
    assert.strictEqual(results[0].status, 'rejected');
    assert.ok(results[0].reason instanceof StatementTimeoutError);
    assert.strictEqual(results[1].status, 'fulfilled');
    assert.deepStrictEqual(results[1].value.rows, [{ b: 7 }]);
    assert.strictEqual(results[2].status, 'fulfilled');
});

test('a read that is itself stopped after being sent again fails; it is not sent a third time', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const id = freshId();
    await engine.exec(OWNER, id, 'CREATE TABLE t (a)');
    setDeadline(engine, OWNER, CUTOFF_MS);
    const results = await Promise.allSettled([
        engine.query(OWNER, id, ENDLESS),
        engine.query(OWNER, id, ENDLESS),
    ]);
    assert.ok(results[0].status === 'rejected' && results[0].reason instanceof StatementTimeoutError);
    assert.ok(results[1].status === 'rejected' && results[1].reason instanceof StatementTimeoutError);
});

test('blob parameters and blob cells cross the process boundary as Buffers', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const id = freshId();
    const blob = Buffer.from([0, 1, 2, 255]);
    await engine.exec(OWNER, id, 'CREATE TABLE b (v BLOB)');
    await engine.exec(OWNER, id, 'INSERT INTO b VALUES (?)', [blob]);
    const { rows } = await engine.query(OWNER, id, 'SELECT v FROM b');
    assert.ok(Buffer.isBuffer(rows[0].v));
    assert.deepStrictEqual(rows[0].v, blob);
    const [{ rows: batched }] = await engine.batch(OWNER, id, [{ sql: 'SELECT v FROM b WHERE v = ?', params: [blob] }]);
    assert.ok(Buffer.isBuffer(batched[0].v));
});

test('0 switches the deadline off: statements run in this process', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: 0 });
    t.after(() => engine.closeAll());
    assert.strictEqual(engine._runner.mode, 'in-process');
    const id = freshId();
    await engine.exec(OWNER, id, 'CREATE TABLE t (a)');
    assert.deepStrictEqual((await engine.query(OWNER, id, 'SELECT 2 AS two')).rows, [{ two: 2 }]);
});

test('the deadline and the page ceiling come from the environment, 0 = unlimited', () => {
    const saved = { t: process.env.SQLITE_STATEMENT_TIMEOUT_MS, p: process.env.SQLITE_MAX_PAGE_COUNT };
    try {
        delete process.env.SQLITE_STATEMENT_TIMEOUT_MS;
        delete process.env.SQLITE_MAX_PAGE_COUNT;
        assert.strictEqual(statementTimeoutMs(), 5000);
        assert.strictEqual(maxPageCount(), DEFAULT_MAX_PAGE_COUNT);
        process.env.SQLITE_STATEMENT_TIMEOUT_MS = '0';
        process.env.SQLITE_MAX_PAGE_COUNT = '0';
        assert.strictEqual(statementTimeoutMs(), 0);
        assert.strictEqual(maxPageCount(), 0);
        assert.strictEqual(createStatementRunner({ entityLabel: 'x', logPrefix: 'x' }).mode, 'in-process');
        process.env.SQLITE_STATEMENT_TIMEOUT_MS = 'abc';
        assert.strictEqual(statementTimeoutMs(), 5000);
    } finally {
        if (saved.t === undefined) delete process.env.SQLITE_STATEMENT_TIMEOUT_MS; else process.env.SQLITE_STATEMENT_TIMEOUT_MS = saved.t;
        if (saved.p === undefined) delete process.env.SQLITE_MAX_PAGE_COUNT; else process.env.SQLITE_MAX_PAGE_COUNT = saved.p;
    }
});

test('a page database cannot grow past the page ceiling', async (t) => {
    process.env.SQLITE_MAX_PAGE_COUNT = '16'; // 64 KiB at 4 KiB pages
    t.after(() => { delete process.env.SQLITE_MAX_PAGE_COUNT; });
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const id = freshId();
    await engine.exec(OWNER, id, 'CREATE TABLE big (v)');
    await assert.rejects(
        engine.exec(OWNER, id, 'INSERT INTO big VALUES (?)', ['x'.repeat(200_000)]),
        /full/i,
    );
});

test('a stop at the deadline leaves the statements of another owner alone, writes included', async (t) => {
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => engine.closeAll());
    const slow = freshId();
    const other = freshId();
    await engine.exec(OWNER, slow, 'CREATE TABLE t (a)');
    await engine.exec('owner-B', other, 'CREATE TABLE u (b)');
    setDeadline(engine, OWNER, CUTOFF_MS);
    const results = await Promise.allSettled([
        engine.query(OWNER, slow, ENDLESS),
        engine.exec('owner-B', other, 'INSERT INTO u VALUES (1)'),
    ]);
    assert.ok(results[0].status === 'rejected' && results[0].reason instanceof StatementTimeoutError);
    assert.strictEqual(results[1].status, 'fulfilled', 'the other owner\'s write runs in its own process');
    assert.deepStrictEqual((await engine.query('owner-B', other, 'SELECT b FROM u')).rows, [{ b: 1 }]);
});

test('the process count is capped and an idle process is retired', async (t) => {
    const runner = createStatementRunner({ timeoutMs: GENEROUS_MS, entityLabel: 'x', logPrefix: 'x', maxProcesses: 2, idleMs: 150 });
    const engine = makeEngine({ statementTimeoutMs: GENEROUS_MS });
    t.after(() => { runner.stop(); return engine.closeAll(); });
    // Real files from the engine; statements sent through a runner with a small cap.
    const ids = [freshId(), freshId(), freshId()];
    const owners = ['o-1', 'o-2', 'o-3'];
    for (let i = 0; i < 3; i++) await engine.exec(owners[i], ids[i], 'CREATE TABLE t (a)');
    const handles = owners.map((o, i) => engine._handles.get(ids[i]));
    for (const h of handles) assert.ok(h, 'handle is open');
    for (const h of handles) await runner.run(h, 'query', ['SELECT 1 AS one', []]);
    assert.ok(runner.lanes.size <= 2, `at most 2 processes (${runner.lanes.size})`);
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(runner.lanes.size, 0, 'idle processes are retired');
    assert.strictEqual(DEFAULT_MAX_PROCESSES > 0 && DEFAULT_IDLE_MS > 0, true);
});
