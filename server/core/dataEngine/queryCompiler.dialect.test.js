/**
 * The dialect must come from the CALLER, not from a process-global.
 *
 * engineFlag.getDialect() answers "which engine does this replica serve App
 * Studio apps from" — a process-wide flag that defaults to 'sqlite' and is
 * left at that default on the standard self-host (docker-compose.from-registry
 * ships STUDIO_APP_ENGINE=${STUDIO_APP_ENGINE:-sqlite}).
 *
 * Automation datatables always live in Postgres, because the sqlite blob engine
 * is single-replica and poisons its handle the moment a second replica writes.
 * So on a default install the global says 'sqlite' while the storage is pg, and
 * compiling under the global is not a crash — it is silently wrong SQL:
 *
 *   contains/startsWith  LIKE instead of ILIKE   → matches fewer rows, no error
 *   empty `in`           0 instead of FALSE      → "argument of AND must be boolean"
 *   date buckets         strftime()              → "function strftime does not exist"
 *   booleans             0/1 instead of true/false
 *   DDL                  created_at TEXT         → CREATE TABLE SUCCEEDS. Silent corruption.
 *
 * These tests pin both directions: an explicit dialect always wins, and passing
 * none preserves the previous behaviour exactly (which is what keeps every App
 * Studio call site byte-identical).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const qc = require('./queryCompiler');
const ddl = require('./dataModel/ddl');
const engineFlag = require('./engineFlag');

const TABLE = {
    id: 'tbl_aaaaaa',
    key: 'people',
    fields: [
        { id: 'f1', key: 'name', type: 'text' },
        { id: 'f2', key: 'active', type: 'bool' },
        { id: 'f3', key: 'joined', type: 'datetime' },
    ],
};
const ALLOW = { where: '1=1', params: [] };

function withEnv(dialect, fn) {
    engineFlag._setForTests(dialect);
    try { return fn(); } finally { engineFlag._setForTests(null); }
}

// ── the explicit option wins, in BOTH directions ────────────────────────────

test('an explicit pg dialect wins over a sqlite process global', () => {
    const { sql } = withEnv('sqlite', () => qc.compileRecordList(
        TABLE, { filters: [{ field: 'name', op: 'contains', value: 'a' }], dialect: 'pg' }, ALLOW));
    assert.match(sql, /ILIKE/, 'explicit pg must emit ILIKE even when the global says sqlite');
    assert.doesNotMatch(sql, /\sLIKE\s/);
});

test('an explicit sqlite dialect wins over a pg process global', () => {
    const { sql } = withEnv('pg', () => qc.compileRecordList(
        TABLE, { filters: [{ field: 'name', op: 'contains', value: 'a' }], dialect: 'sqlite' }, ALLOW));
    assert.match(sql, /\sLIKE\s/, 'explicit sqlite must emit LIKE even when the global says pg');
    assert.doesNotMatch(sql, /ILIKE/);
});

test('passing no dialect follows the process global — the App Studio contract', () => {
    const asSqlite = withEnv('sqlite', () => qc.compileRecordList(
        TABLE, { filters: [{ field: 'name', op: 'contains', value: 'a' }] }, ALLOW).sql);
    const asPg = withEnv('pg', () => qc.compileRecordList(
        TABLE, { filters: [{ field: 'name', op: 'contains', value: 'a' }] }, ALLOW).sql);
    assert.match(asSqlite, /\sLIKE\s/);
    assert.match(asPg, /ILIKE/);
});

test('resolveDialect rejects a dialect that is neither pg nor sqlite', () => {
    assert.throws(() => engineFlag.resolveDialect({ dialect: 'mysql' }), /must be 'pg', 'sqlite' or absent/);
    // absent / null / undefined all fall through to the global
    assert.strictEqual(withEnv('pg', () => engineFlag.resolveDialect({})), 'pg');
    assert.strictEqual(withEnv('pg', () => engineFlag.resolveDialect({ dialect: null })), 'pg');
    assert.strictEqual(withEnv('pg', () => engineFlag.resolveDialect(undefined)), 'pg');
});

// ── each dialect-sensitive site, under a MISMATCHED global ──────────────────

test('an empty `in` emits FALSE under pg and 0 under sqlite', () => {
    const pg = withEnv('sqlite', () => qc.compileRecordList(
        TABLE, { filters: [{ field: 'name', op: 'in', value: [] }], dialect: 'pg' }, ALLOW).sql);
    const lite = withEnv('pg', () => qc.compileRecordList(
        TABLE, { filters: [{ field: 'name', op: 'in', value: [] }], dialect: 'sqlite' }, ALLOW).sql);
    assert.match(pg, /FALSE/, 'pg AND demands a boolean operand');
    assert.doesNotMatch(lite, /FALSE/);
    assert.match(lite, /\b0\b/);
});

test('a boolean filter value binds true/false under pg and 1/0 under sqlite', () => {
    const pg = withEnv('sqlite', () => qc.compileRecordList(
        TABLE, { filters: [{ field: 'active', op: 'eq', value: true }], dialect: 'pg' }, ALLOW));
    const lite = withEnv('pg', () => qc.compileRecordList(
        TABLE, { filters: [{ field: 'active', op: 'eq', value: true }], dialect: 'sqlite' }, ALLOW));
    assert.ok(pg.params.includes(true), 'pg binds a real boolean');
    assert.ok(lite.params.includes(1), 'better-sqlite3 refuses a raw boolean');
});

test('a date bucket compiles to to_char under pg and strftime under sqlite', () => {
    const pg = withEnv('sqlite', () => qc.compileAggregate(
        TABLE, { groupBy: [{ field: 'joined', bucket: 'day' }], aggregates: [{ fn: 'count' }], dialect: 'pg' }, ALLOW).sql);
    const lite = withEnv('pg', () => qc.compileAggregate(
        TABLE, { groupBy: [{ field: 'joined', bucket: 'day' }], aggregates: [{ fn: 'count' }], dialect: 'sqlite' }, ALLOW).sql);
    assert.match(pg, /to_char/);
    assert.doesNotMatch(pg, /strftime/);
    assert.match(lite, /strftime/);
});

test('a boolean write value coerces per dialect, not per global', () => {
    const pg = withEnv('sqlite', () => qc.compileInsert(TABLE, { active: true }, { dialect: 'pg' }));
    const lite = withEnv('pg', () => qc.compileInsert(TABLE, { active: true }, { dialect: 'sqlite' }));
    assert.ok(pg.params.includes(true));
    assert.ok(lite.params.includes(1));
});

// ── DDL is the dangerous one: the wrong dialect SUCCEEDS ────────────────────

test('DDL emits Postgres column types under an explicit pg dialect', () => {
    const sql = withEnv('sqlite', () => ddl.ddlForTable(TABLE, { dialect: 'pg' }));
    assert.match(sql, /created_at TIMESTAMPTZ/, 'a TEXT timestamp column is silent corruption, not an error');
    assert.match(sql, /"active" BOOLEAN/);
    assert.match(sql, /"joined" TIMESTAMPTZ/);
});

test('DDL still emits SQLite types when no dialect is passed', () => {
    const sql = withEnv('sqlite', () => ddl.ddlForTable(TABLE));
    assert.match(sql, /created_at TEXT/);
    assert.match(sql, /"active" INTEGER/);
});

test('migrationPlan threads the dialect into every emitter it calls', () => {
    const { migrationPlan } = require('./dataModel/migrationPlan');
    const empty = { modelVersion: 1, tables: [] };
    const next = { modelVersion: 1, tables: [TABLE] };
    const plan = withEnv('sqlite', () => migrationPlan(empty, next, { dialect: 'pg' }));
    const joined = plan.join('\n');
    assert.match(joined, /TIMESTAMPTZ/, 'a plan compiled for pg must not carry sqlite column types');
    assert.doesNotMatch(joined, /created_at TEXT/);
});
