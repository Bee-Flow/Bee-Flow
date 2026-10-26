// @typecheck strict
'use strict';

/**
 * stores/lib/ddlLedger.js against a real Postgres (PGlite behind the real
 * db.js, testUtils/pglitePool), with small synthetic store inits. Every
 * "boot" is a NEW makeStoreInit memo under the same tag, which is what a
 * restarted server is to the ledger.
 *
 * What is proven here, per statement: a fresh database runs and records
 * everything; an unchanged second boot sends no schema statement at all; a new
 * or edited statement runs on an install that recorded the old set; a failed
 * or tolerated statement is never recorded; a table dropped or recreated
 * behind the ledger, or a retired index that came back, makes the unit run
 * again; data statements and code outside an init are never skipped; --force,
 * BEEFLOW_DDL_LEDGER=off and a db double without ledgerQuery run everything.
 * The whole fleet of real stores is proven in boot/schemaLedger.integration.test.js.
 *
 * Run: cd server && node --test stores/lib/ddlLedger.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { query: rawQuery, close } = usePglitePool();
after(close);

const db = require('../../db');
const ledger = require('./ddlLedger');
const { makeStoreInit } = require('./storeInit');
const { runDdl, CODES } = require('./_ddl');

/**
 * @param {string} sql @param {unknown[]} [params]
 * @returns {Promise<any[]>}
 */
const q = async (sql, params) => (await rawQuery(sql, params)).rows;

/**
 * One boot of a synthetic store: a fresh memo, run once, and the statements
 * the ledger executed and skipped while it ran.
 * @param {string} tag
 * @param {() => Promise<unknown>} schemaFn
 */
async function boot(tag, schemaFn) {
    /** @type {string[]} */ const executed = [];
    /** @type {string[]} */ const skipped = [];
    const stop = ledger.observe((e) => {
        if (e.unit !== ledger.UNIT_PREFIX + tag) return;
        (e.outcome === 'executed' ? executed : skipped).push(e.sql.replace(/\s+/g, ' ').trim());
    });
    try {
        await makeStoreInit(tag, async () => { await schemaFn(); })();
    } finally {
        stop();
    }
    return { executed, skipped };
}

/** @param {string} table @param {string} column */
async function hasColumn(table, column) {
    return (await q(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column])).length === 1;
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('only schema statements without data in them are skippable', () => {
    for (const sql of [
        'CREATE TABLE IF NOT EXISTS t (id int)',
        '  -- a comment first\n  ALTER TABLE t ADD COLUMN IF NOT EXISTS x int',
        'DROP INDEX IF EXISTS idx_old',
        "COMMENT ON COLUMN t.x IS 'done'",
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'c') THEN ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0); END IF; END $$",
        'ALTER TABLE a ADD CONSTRAINT f FOREIGN KEY (b) REFERENCES c(id) ON DELETE CASCADE ON UPDATE CASCADE',
        'CREATE TRIGGER trg BEFORE INSERT OR UPDATE OF content ON t FOR EACH ROW EXECUTE FUNCTION f()',
    ]) assert.strictEqual(ledger.isSchemaOnly(sql), true, sql);
    for (const sql of [
        'SELECT 1',
        "UPDATE t SET x = 1 WHERE x IS NULL",
        "DO $$ BEGIN ALTER TABLE t ADD COLUMN IF NOT EXISTS y int; UPDATE t SET y = 0; END $$",
        'CREATE TEMP TABLE scratch (id int)',
        'CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $f$ BEGIN INSERT INTO log VALUES (1); RETURN NEW; END $f$ LANGUAGE plpgsql',
        'TRUNCATE t',
    ]) assert.strictEqual(ledger.isSchemaOnly(sql), false, sql);
});

test('the relations a unit touches are read from its statements', () => {
    assert.deepStrictEqual(ledger.relationsIn([
        'CREATE TABLE IF NOT EXISTS foo (id int)',
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_a ON foo(lower(x))',
        'CREATE INDEX IF NOT EXISTS "IDX_x" ON "user_sessions" ("expire")',
        'ALTER TABLE IF EXISTS ONLY baz ADD COLUMN IF NOT EXISTS y int',
        'ALTER TABLE t RENAME COLUMN a TO b',
        'DROP INDEX IF EXISTS idx_old',
        'ALTER TABLE routine_credentials RENAME TO automation_credentials',
    ]), ['"IDX_x"', '"user_sessions"', 'automation_credentials', 'baz', 'foo', 'idx_old', 'routine_credentials', 't', 'uq_a']);
});

// ── a store init through the ledger ─────────────────────────────────────────

const V1 = [
    'CREATE TABLE IF NOT EXISTS ledger_t1 (id SERIAL PRIMARY KEY, name TEXT)',
    'ALTER TABLE ledger_t1 ADD COLUMN IF NOT EXISTS note TEXT',
    'CREATE INDEX IF NOT EXISTS idx_ledger_t1_name ON ledger_t1(name)',
];

test('a fresh database runs every statement and records the unit', async () => {
    const r = await boot('LedgerT1', async () => { for (const s of V1) await db.exec(s); });
    assert.deepStrictEqual(r.executed, V1);
    assert.deepStrictEqual(r.skipped, []);
    const [row] = await q(`SELECT checksum, ddl_statements, ddl_tables FROM schema_migrations WHERE name = 'store:LedgerT1'`);
    assert.match(row.checksum, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual([...row.ddl_statements].sort(), V1.map(ledger.statementKey).sort());
    assert.deepStrictEqual(Object.keys(row.ddl_tables).sort(), ['idx_ledger_t1_name', 'ledger_t1']);
    assert.ok(Object.values(row.ddl_tables).every((oid) => /^\d+$/.test(String(oid))), 'every relation is recorded with its OID');
});

test('an unchanged second boot sends no schema statement and keeps the data', async () => {
    await q(`INSERT INTO ledger_t1 (name, note) VALUES ('keep', 'me')`);
    /** @type {string[]} */ const sent = [];
    const pool = db.pool;
    const real = pool.query;
    pool.query = /** @type {any} */ (async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => { sent.push(String(sql)); return real(sql, params); });
    try {
        const r = await boot('LedgerT1', async () => { for (const s of V1) await db.exec(s); });
        assert.deepStrictEqual(r.executed, []);
        assert.deepStrictEqual(r.skipped, V1);
    } finally {
        pool.query = real;
    }
    assert.deepStrictEqual(sent.filter((s) => ledger.isSchemaOnly(s)), [], 'not one schema statement reaches the database');
    assert.strictEqual(sent.length, 1, 'one ledger read, and no write when nothing changed');
    assert.deepStrictEqual(await q(`SELECT name, note FROM ledger_t1`), [{ name: 'keep', note: 'me' }]);
});

test('a NEW statement runs on an install that recorded the old set, the rest is skipped', async () => {
    const added = 'ALTER TABLE ledger_t1 ADD COLUMN IF NOT EXISTS added_later INT';
    const r = await boot('LedgerT1', async () => { for (const s of [...V1, added]) await db.exec(s); });
    assert.deepStrictEqual(r.executed, [added]);
    assert.deepStrictEqual(r.skipped, V1);
    assert.ok(await hasColumn('ledger_t1', 'added_later'));
    const again = await boot('LedgerT1', async () => { for (const s of [...V1, added]) await db.exec(s); });
    assert.deepStrictEqual(again.executed, [], 'and from then on it is recorded too');
});

test('an EDITED statement is a new text and runs again', async () => {
    const edited = 'CREATE INDEX IF NOT EXISTS idx_ledger_t1_note ON ledger_t1(note)';
    const r = await boot('LedgerT1', async () => { for (const s of [V1[0], V1[1], edited]) await db.exec(s); });
    assert.deepStrictEqual(r.executed, [edited]);
    assert.strictEqual((await q(`SELECT to_regclass('idx_ledger_t1_note') IS NOT NULL AS ok`))[0].ok, true);
});

test('a failed statement is not recorded and runs again on the next boot', async () => {
    const bad = 'ALTER TABLE ledger_t1 ADD CONSTRAINT ledger_t1_bad CHECK (no_such_column > 0)';
    const fn = async () => {
        await db.exec(V1[0]);
        await db.exec(bad).catch(() => { /* the store swallows it, as many do */ });
    };
    const first = await boot('LedgerFail', fn);
    assert.deepStrictEqual(first.executed, [V1[0]]);
    /** @type {string[]} */ const tried = [];
    const pool = db.pool;
    const real = pool.query;
    const realConnect = pool.connect;
    const spy = async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => { tried.push(String(sql)); return real(sql, params); };
    pool.query = /** @type {any} */ (spy);
    pool.connect = /** @type {any} */ (async () => ({ query: spy, release() {} }));
    try {
        await boot('LedgerFail', fn);
    } finally {
        pool.query = real;
        pool.connect = realConnect;
    }
    assert.ok(tried.includes(bad), 'the failed statement is sent again');
    assert.ok(!tried.includes(V1[0]), 'the one that succeeded is not');
});

test('runDdl: a recorded list costs no transaction, a tolerated statement is never recorded', async () => {
    const list = [
        'CREATE TABLE IF NOT EXISTS ledger_t2 (id INT)',
        { sql: 'ALTER TABLE ledger_missing ADD COLUMN IF NOT EXISTS x INT', tolerate: CODES.UNDEFINED_TABLE },
    ];
    const first = await boot('LedgerRunDdl', () => runDdl('ledgerT2', list));
    assert.deepStrictEqual(first.executed, ['CREATE TABLE IF NOT EXISTS ledger_t2 (id INT)']);

    /** @type {string[]} */ const sent = [];
    const pool = db.pool;
    const real = pool.query;
    const realConnect = pool.connect;
    const spy = async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => { sent.push(String(sql)); return real(sql, params); };
    pool.query = /** @type {any} */ (spy);
    pool.connect = /** @type {any} */ (async () => ({ query: spy, release() {} }));
    try {
        const again = await boot('LedgerRunDdl', () => runDdl('ledgerT2', list));
        assert.deepStrictEqual(again.skipped, ['CREATE TABLE IF NOT EXISTS ledger_t2 (id INT)']);
        assert.ok(sent.some((s) => s.includes('ledger_missing')), 'the tolerated statement runs again');
        const onlyRecorded = await boot('LedgerRunDdlAll', async () => {
            await runDdl('ledgerT2b', ['CREATE TABLE IF NOT EXISTS ledger_t2b (id INT)']);
        });
        assert.strictEqual(onlyRecorded.executed.length, 1);
        sent.length = 0;
        await boot('LedgerRunDdlAll', async () => {
            await runDdl('ledgerT2b', ['CREATE TABLE IF NOT EXISTS ledger_t2b (id INT)']);
        });
        assert.deepStrictEqual(sent.filter((s) => /BEGIN|advisory|SAVEPOINT/i.test(s)), [],
            'a list that is all recorded opens no transaction and takes no lock');
    } finally {
        pool.query = real;
        pool.connect = realConnect;
    }
});

test('a table dropped or recreated behind the ledger makes the whole unit run again', async () => {
    const fn = async () => { for (const s of V1) await db.exec(s); };
    await boot('LedgerDrop', fn);
    await q('DROP TABLE ledger_t1');
    const r = await boot('LedgerDrop', fn);
    assert.deepStrictEqual(r.executed, V1, 'every statement runs again, not only the CREATE TABLE');
    assert.ok(await hasColumn('ledger_t1', 'note'));
});

test('a retired index that came back is dropped again', async () => {
    const fn = async () => {
        await db.exec('CREATE TABLE IF NOT EXISTS ledger_t3 (id INT, v INT)');
        await db.exec('DROP INDEX IF EXISTS idx_ledger_t3_retired');
    };
    await q('CREATE TABLE ledger_t3 (id INT, v INT)');
    await q('CREATE INDEX idx_ledger_t3_retired ON ledger_t3(v)');
    await boot('LedgerRetired', fn);
    assert.strictEqual((await q(`SELECT to_regclass('idx_ledger_t3_retired') AS r`))[0].r, null);
    await q('CREATE INDEX idx_ledger_t3_retired ON ledger_t3(v)');   // an older replica put it back
    const r = await boot('LedgerRetired', fn);
    assert.ok(r.executed.includes('DROP INDEX IF EXISTS idx_ledger_t3_retired'));
    assert.strictEqual((await q(`SELECT to_regclass('idx_ledger_t3_retired') AS r`))[0].r, null);
});

test('data statements and work outside an init are never skipped', async () => {
    await q('CREATE TABLE IF NOT EXISTS ledger_t4 (id INT)');
    const fn = async () => {
        await db.exec('ALTER TABLE ledger_t4 ADD COLUMN IF NOT EXISTS n INT');
        await db.run('INSERT INTO ledger_t4 (id, n) VALUES (1, 1)');
    };
    await boot('LedgerData', fn);
    await boot('LedgerData', fn);
    assert.strictEqual((await q('SELECT count(*)::int AS n FROM ledger_t4'))[0].n, 2, 'the INSERT ran on both boots');

    // The same recorded text, sent by a request rather than an init, is sent.
    await q('ALTER TABLE ledger_t4 DROP COLUMN n');
    await db.exec('ALTER TABLE ledger_t4 ADD COLUMN IF NOT EXISTS n INT');
    assert.ok(await hasColumn('ledger_t4', 'n'));
});

test('once(): a data step is recorded when it finished and skipped after that', async () => {
    let runs = 0;
    let finish = false;
    const fn = () => ledger.once('backfill', 'UPDATE x SET y = 1', async () => { runs++; return finish ? undefined : false; });
    await boot('LedgerOnce', fn);
    await boot('LedgerOnce', fn);
    assert.strictEqual(runs, 2, 'a step that reports false is not finished and runs again');
    finish = true;
    await boot('LedgerOnce', fn);
    await boot('LedgerOnce', fn);
    assert.strictEqual(runs, 3, 'finished once, skipped from then on');
    await boot('LedgerOnce', () => ledger.once('backfill', 'UPDATE x SET y = 2', async () => { runs++; }));
    assert.strictEqual(runs, 4, 'a new version of the step runs again');
});

test('--force, BEEFLOW_DDL_LEDGER=off and a db double without ledgerQuery run everything', async () => {
    const fn = async () => { for (const s of V1) await db.exec(s); };
    await boot('LedgerForce', fn);
    ledger.setForce(true);
    try {
        assert.deepStrictEqual((await boot('LedgerForce', fn)).executed, V1);
    } finally {
        ledger.setForce(false);
    }
    assert.deepStrictEqual((await boot('LedgerForce', fn)).executed, [], 'and --force recorded what it ran');

    process.env.BEEFLOW_DDL_LEDGER = 'off';
    try {
        let ran = 0;
        await makeStoreInit('LedgerOff', async () => { await db.exec(V1[0]); ran++; })();
        assert.strictEqual(ran, 1);
        assert.deepStrictEqual(await q(`SELECT 1 FROM schema_migrations WHERE name = 'store:LedgerOff'`), []);
    } finally {
        delete process.env.BEEFLOW_DDL_LEDGER;
    }

    const r = await ledger.runUnit('NoLedger', async () => 'ran', undefined);
    assert.strictEqual(r, 'ran');
    assert.deepStrictEqual(await q(`SELECT 1 FROM schema_migrations WHERE name = 'store:NoLedger'`), []);
});

test('an install from before the store schemas joined the ledger keeps its rows and gets the columns', async () => {
    await q('DROP TABLE schema_migrations');
    await q(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum TEXT NOT NULL)`);
    await q(`INSERT INTO schema_migrations (name, checksum) VALUES ('some-migration-2026-01', 'abc')`);
    const r = await boot('LedgerUpgrade', async () => { await db.exec('CREATE TABLE IF NOT EXISTS ledger_t5 (id INT)'); });
    assert.deepStrictEqual(r.executed, ['CREATE TABLE IF NOT EXISTS ledger_t5 (id INT)']);
    const rows = await q(`SELECT name, checksum FROM schema_migrations ORDER BY name`);
    assert.deepStrictEqual(rows.map((x) => x.name), ['some-migration-2026-01', 'store:LedgerUpgrade']);
    assert.strictEqual(rows[0].checksum, 'abc', 'the migration row is untouched');
});

test('a fresh database without any ledger table gets one on the first init', async () => {
    await q('DROP TABLE schema_migrations');
    const r = await boot('LedgerBootstrap', async () => { await db.exec('CREATE TABLE IF NOT EXISTS ledger_t6 (id INT)'); });
    assert.strictEqual(r.executed.length, 1);
    assert.strictEqual((await q(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = 'store:LedgerBootstrap'`))[0].n, 1);
});
