/**
 * Statement check for page databases: the pure guard plus the shared engine
 * that applies it (query, exec, batch, applyMigration). Real SQLite work runs
 * in a throwaway directory; tests skip when the native binding is unavailable.
 *
 * Run: node --test stores/lib/sqliteStatementGuard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertPageStatement, NOT_ALLOWED_MESSAGE } = require('./sqliteStatementGuard');
const { createSqliteBlobEngine } = require('./sqliteBlobEngine');
const { createRecordingDb } = require('../../testUtils/mockDb');

const OWNER = 'owner-A';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-guard-test-'));
const outside = path.join(sandbox, 'outside');
fs.mkdirSync(outside);
const target = path.join(outside, 'x.db');
test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const REFUSED = [
    `ATTACH DATABASE '${target}' AS x`,
    `attach '${target}' as x`,
    `ATTACH 'relative-x.db' AS x`,
    `ATTACH 'file:${target}?mode=rwc' AS x`,
    `ATTACH ? AS x`,
    `/* c */ ATTACH '${target}' AS x`,
    `-- c\nATTACH '${target}' AS x`,
    `  \n\t(ATTACH '${target}' AS x)`,
    `DETACH DATABASE x`,
    `CREATE TABLE t (a); ATTACH '${target}' AS x`,
    `SELECT 1; /* a */ ATTACH '${target}' AS x; SELECT 2`,
    `VACUUM INTO '${target}'`,
    `vacuum`,
    `PRAGMA database_list`,
    `PRAGMA main.table_info(t)`,
    `PRAGMA journal_mode = DELETE`,
    `PRAGMA journal_mode=WAL`,
    `PRAGMA foreign_keys = OFF`,
    `PRAGMA table_info = 1`,
    `SELECT * FROM pragma_database_list`,
    `SELECT * FROM pragma_database_list()`,
    `SELECT * FROM "pragma_database_list"`,
    `SELECT * FROM pragma_journal_mode`,
    `SELECT load_extension('x')`,
    `SELECT "load_extension"('x')`,
    `EXPLAIN SELECT 1`,
    `CREATE TRIGGER tr AFTER INSERT ON t BEGIN ATTACH 'x' AS y; END`,
    ``,
    `   `,
    `-- only a comment`,
];

for (const sql of REFUSED) {
    test(`guard refuses: ${JSON.stringify(sql.replaceAll(target, '<path>')).slice(0, 70)}`, () => {
        assert.throws(() => assertPageStatement(sql), (err) => {
            assert.strictEqual(err.message, NOT_ALLOWED_MESSAGE);
            return true;
        });
    });
}

const ALLOWED = [
    'SELECT * FROM t WHERE a = ?',
    'select 1',
    `SELECT 'ATTACH DATABASE x' AS note`,
    `SELECT "attach" FROM t`,
    `INSERT INTO t (a) VALUES ('; ATTACH ''x'' AS y')`,
    `WITH c AS (SELECT 1) SELECT * FROM c`,
    `(SELECT 1)`,
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'REPLACE INTO t (a) VALUES (1)',
    'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, a TEXT)',
    'CREATE TEMP TABLE tt (a)',
    'CREATE UNIQUE INDEX i ON t (a)',
    'CREATE VIEW v AS SELECT 1',
    'DROP TABLE t',
    'ALTER TABLE t ADD COLUMN b TEXT',
    'BEGIN; INSERT INTO t VALUES (1); COMMIT',
    'SAVEPOINT s; RELEASE s',
    'PRAGMA table_info(t)',
    'PRAGMA table_xinfo("t")',
    'PRAGMA index_list(t)',
    'PRAGMA index_info(i)',
    'PRAGMA index_xinfo(i)',
    'PRAGMA foreign_key_list(t)',
    `SELECT * FROM pragma_table_info('t')`,
    'SELECT name FROM pragma_index_list("t")',
    'CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = CASE WHEN 1 THEN 2 ELSE 3 END; INSERT INTO log VALUES (1); END; SELECT 1',
];

for (const sql of ALLOWED) {
    test(`guard allows: ${JSON.stringify(sql).slice(0, 70)}`, () => {
        assert.doesNotThrow(() => assertPageStatement(sql));
    });
}

// ── The shared engine applies it ─────────────────────────────────────

const storage = {
    isAvailable: () => false,
    streamFile: async () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; },
    uploadFile: async () => ({}),
    deleteFile: async () => {},
};
const mock = createRecordingDb({ tables: { things: [] } });
const engine = createSqliteBlobEngine({
    workDir: path.join(sandbox, 'work'),
    buildKey: (ownerId, id) => `things/${ownerId}/${id}/data.db`,
    metaTable: 'things',
    logPrefix: 'ThingDB',
    entityLabel: 'Thing DB',
    storage,
    runQuery: mock.db.run,
});
const freshId = () => `thing-${crypto.randomBytes(6).toString('hex')}`;

let sqliteUsable = true;
let probeError = '';
test('(setup) probe sqlite availability', async () => {
    const id = freshId();
    try { await engine.exec(OWNER, id, 'SELECT 1'); } catch (e) { sqliteUsable = false; probeError = e.message; }
    finally { try { await engine.invalidate(id); } catch (_) {} }
});
const skip = (t) => { if (!sqliteUsable) { t.skip(`native binding unavailable: ${probeError}`); return true; } return false; };

const REFUSE_RE = /This statement is not allowed in a page database/;

test('engine: file-reaching and state-changing statements are refused and create no file', async (t) => {
    if (skip(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    const attempts = [
        `ATTACH DATABASE '${target}' AS x`,
        `attach '${path.relative(process.cwd(), target)}' as x`,
        `ATTACH 'file:${target}?mode=rwc' AS x`,
        `/**/ aTtAcH '${target}' AS x`,
        `CREATE TABLE t (a); ATTACH '${target}' AS x`,
        `VACUUM INTO '${target}'`,
        `PRAGMA database_list`,
        `SELECT * FROM pragma_database_list`,
        `PRAGMA journal_mode = DELETE`,
    ];
    for (const sql of attempts) {
        await assert.rejects(engine.exec(OWNER, id, sql), REFUSE_RE, sql);
        await assert.rejects(engine.query(OWNER, id, sql), REFUSE_RE, sql);
        await assert.rejects(engine.batch(OWNER, id, [{ sql }]), REFUSE_RE, sql);
        await assert.rejects(engine.applyMigration(OWNER, id, [sql]), REFUSE_RE, sql);
    }
    assert.strictEqual(fs.existsSync(target), false, 'no file appeared');
    assert.deepStrictEqual(fs.readdirSync(outside), []);
    // A refused multi-statement script ran none of its statements.
    const tables = await engine.schema(OWNER, id);
    assert.deepStrictEqual(tables.tables, []);
});

test('engine: normal statements, parameters and read PRAGMAs still work', async (t) => {
    if (skip(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    await engine.exec(OWNER, id, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const ins = await engine.exec(OWNER, id, 'INSERT INTO t (name) VALUES (?)', ['a']);
    assert.strictEqual(ins.changes, 1);
    await engine.exec(OWNER, id, 'UPDATE t SET name = ? WHERE id = ?', ['b', ins.lastInsertRowid]);
    const { rows } = await engine.query(OWNER, id, 'SELECT name FROM t WHERE id = ?', [ins.lastInsertRowid]);
    assert.strictEqual(rows[0].name, 'b');
    const multi = await engine.exec(OWNER, id, 'CREATE TABLE a (x); CREATE TABLE b (y);');
    assert.strictEqual(multi.multi, true);
    const info = await engine.query(OWNER, id, 'PRAGMA table_info(t)');
    assert.deepStrictEqual(info.rows.map(r => r.name), ['id', 'name']);
    const fn = await engine.query(OWNER, id, "SELECT name FROM pragma_table_info('t')");
    assert.strictEqual(fn.rows.length, 2);
    const [res] = await engine.batch(OWNER, id, [{ sql: 'INSERT INTO t (name) VALUES (?)', params: ['c'] }]);
    assert.strictEqual(res.changes, 1);
    assert.strictEqual((await engine.applyMigration(OWNER, id, ['ALTER TABLE t ADD COLUMN z TEXT'])).applied, 1);
    await engine.exec(OWNER, id, 'DELETE FROM t');
    assert.strictEqual((await engine.schema(OWNER, id)).tables.length, 3);
});

// ── Tricky inputs: the tokenizer fails closed ────────────────────────

const T = target.replaceAll('\\', '/');
const A = `ATTACH '${T}' AS x`;
const TRICKY_REFUSED = [
    `AT/**/TACH '${T}' AS x`,
    `ATTACH/**/'${T}' AS x`,
    `SELECT 1;\n${A}`,
    `SELECT 1;\t${A}`,
    `SELECT 1;\f${A}`,
    `SELECT 1;\v${A}`,
    `SELECT 1;\r\n${A}`,
    `SELECT 1; ${A}`,
    `SELECT 1; ${A}`,
    `SELECT 1;\u0085${A}`,
    `SELECT 1;\u0000${A}`,
    `ATTACH '${T}' AS x`,
    `SELECT 1; ${A} --`,
    `SELECT 1; ${A} -- ; SELECT 2`,
    `SELECT 'unterminated`,
    `SELECT "unterminated`,
    `SELECT [unterminated`,
    'SELECT `unterminated',
    `SELECT /* unterminated`,
    `SELECT 1; /* ${A}`,
    `SELECT 1; '${A}`,
    `SELECT /* /* nested */ 1; ${A} */`,
    `SELECT 'it''s'; ${A}`,
    `SELECT 'it'''; ${A}`,
    `SELECT X'41'; ${A}`,
    `SELECT x'41'; ${A}`,
    `SELECT "a""b"; ${A}`,
    `SELECT 'a\\'; ${A}; --'`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END ; ${A}`,
    `CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 2 END; END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN CASE WHEN 1 THEN 2 END END; END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 'case'; END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT "case"; END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT "end"; END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1 AS endx, case_ FROM t; END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END END; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; ${A}`,
    `CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 2; ${A}; END`,
    `create trigger t after insert on x begin select 1; end; attach '${T}' as x`,
    `CREATE VIEW v AS SELECT 1; ${A}`,
    `WITH c AS (SELECT 1) SELECT 1; ${A}`,
    `WITH c AS (SELECT 1) ${A}`,
    `EXPLAIN SELECT 1`,
    `explain query plan SELECT 1`,
    `EXPLAIN ${A}`,
    `VACUUM`,
    `VACUUM main`,
    `VACUUM INTO '${T}'`,
    `SELECT 1; VACUUM INTO '${T}'`,
    `SELECT * FROM main.pragma_database_list`,
    `SELECT * FROM main.pragma_database_list()`,
    `SELECT * FROM temp."pragma_database_list"`,
    `SELECT * FROM "pragma_database_list"`,
    `SELECT * FROM [pragma_database_list]`,
    'SELECT * FROM `pragma_database_list`',
    `SELECT * FROM PRAGMA_DATABASE_LIST`,
    `SELECT * FROM pragma_function_list`,
    `SELECT * FROM pragma_compile_options`,
    `PRAGMA main.table_info(x)`,
    `PRAGMA table_info = x`,
    `PRAGMA table_info(x) = 1`,
    `PRAGMA "database_list"`,
    `PRAGMA journal_mode`,
    `PRAGMA writable_schema = 1`,
    `PRAGMA user_version = 5`,
    `SELECT 1 /* ; */ ; ${A}`,
    `;${A}`,
    `(${A})`,
];

const TRICKY_ALLOWED = [
    'SELECT 1 --',
    "SELECT 1 -- ; ATTACH 'x' AS y",
    "SELECT 'it''s'",
    "SELECT 'a;b'",
    "SELECT X'4141'",
    "SELECT 'x' /* ATTACH */",
    'SELECT "attach" FROM t',
    'SELECT [vacuum] FROM t',
    'SELECT `detach` FROM t',
    'CREATE TABLE t ("attach" TEXT, [vacuum] TEXT, `detach` TEXT)',
    'INSERT INTO t ("attach", [vacuum], `detach`) VALUES (1, 2, 3)',
    'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 2 END; END; SELECT 1',
    "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 'end'; SELECT 2; END",
    "SELECT * FROM pragma_table_info('x', 'temp')",
    'PRAGMA table_info(x)',
];

for (const sql of TRICKY_REFUSED) {
    test(`tricky refused: ${JSON.stringify(sql.replaceAll(T, '<path>')).slice(0, 80)}`, () => {
        assert.throws(() => assertPageStatement(sql), (err) => err.message === NOT_ALLOWED_MESSAGE);
    });
}
for (const sql of TRICKY_ALLOWED) {
    test(`tricky allowed: ${JSON.stringify(sql).slice(0, 80)}`, () => {
        assert.doesNotThrow(() => assertPageStatement(sql));
    });
}

test('engine: every tricky refusal holds through exec, query, batch and applyMigration, with no file created', async (t) => {
    if (skip(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    for (const sql of TRICKY_REFUSED) {
        await assert.rejects(engine.exec(OWNER, id, sql), REFUSE_RE, sql);
        await assert.rejects(engine.query(OWNER, id, sql), REFUSE_RE, sql);
        await assert.rejects(engine.batch(OWNER, id, [{ sql }]), REFUSE_RE, sql);
        await assert.rejects(engine.applyMigration(OWNER, id, [sql]), REFUSE_RE, sql);
    }
    assert.deepStrictEqual(fs.readdirSync(outside), [], 'no file appeared');
    assert.strictEqual(fs.existsSync(target), false);
});

test('engine: keywords as quoted identifiers work as column names', async (t) => {
    if (skip(t)) return;
    const id = freshId();
    t.after(() => engine.invalidate(id));
    await engine.exec(OWNER, id, 'CREATE TABLE q ("attach" TEXT, [vacuum] TEXT, `detach` TEXT)');
    await engine.exec(OWNER, id, 'INSERT INTO q ("attach", [vacuum], `detach`) VALUES (?, ?, ?)', ['a', 'b', 'c']);
    const { rows } = await engine.query(OWNER, id, 'SELECT "attach", [vacuum], `detach` FROM q');
    assert.deepStrictEqual(rows, [{ attach: 'a', vacuum: 'b', detach: 'c' }]);
    await engine.exec(OWNER, id, "CREATE TRIGGER q_t AFTER INSERT ON q BEGIN UPDATE q SET \"attach\" = CASE WHEN 1 THEN 'z' END; END");
});
