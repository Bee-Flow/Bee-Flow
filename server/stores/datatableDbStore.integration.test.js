'use strict';

/**
 * Datatables, END TO END, against a REAL Postgres.
 *
 * datatableDbStore.test.js and datatableStore.test.js read their subject with
 * fs.readFileSync and match regexes against it. They pin real architectural
 * invariants — Postgres always, never the sqlite blob engine, the DROP rides
 * the metadata transaction — and by construction they cannot see a wrong value,
 * a missing row, an off-by-one slice or an upsert that appends. Every write bug
 * this file exists for was invisible to `npm test`: the executor's store stub
 * answered rows regardless of the SQL it was handed, so a probe whose access
 * filter compiled to `1=0` still "found" the row it was built to miss.
 *
 * ── WHY pglite AND NOT A CONTAINER ──────────────────────────────────
 * @electric-sql/pglite is already a devDependency, and stores/lib/
 * pgAppEngine.test.js + pgAppEngine.isolation.test.js already back this exact
 * engine with it — real Postgres, compiled to WASM, in this process. So this
 * suite ALWAYS runs: no service container, no DATATABLE_TEST_PG, no self-skip.
 * A suite that skips when the database is missing protects nothing on the
 * developer machine where the bug is written, and this one has no reason to.
 *
 * The seam is db.js, stubbed through require.cache before the stores load —
 * the same technique execDatatable.test.js uses. Everything above it is the
 * genuine article: datatableStore's own createSchema DDL, its transactions,
 * pgAppEngine, the query compiler, the access filter and the datatable step.
 *
 * Run: cd server && node --test --test-force-exit stores/datatableDbStore.integration.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');

// ── A db.js facade over one pglite connection ───────────────────────────────

// Constructed BEFORE the stores are required, not in before(): every store in
// the require graph kicks off its own createSchema at load time, and a null
// handle there turns this file's output into a wall of unrelated init errors.
// The PGlite constructor returns immediately; the first query awaits readiness.
const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

/** node-pg's result shape from pglite's. `fields` is what normalizeRows reads. */
function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
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

// pglite is ONE connection, so every "client" is that connection and the tests
// below must stay sequential — two overlapping transactions would interleave.
const client = { query: (sql, params) => rawQuery(sql, params), release: () => {} };

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    pool: { query: rawQuery, connect: async () => client },
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
    getClient: async () => client,
    withTransaction: async (fn) => {
        await client.query('BEGIN');
        try {
            const out = await fn(client);
            await client.query('COMMIT');
            return out;
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
            throw e;
        }
    },
    makeStoreInit: (tag, schemaFn) => {
        let promise = null;
        return function ensureInit() {
            if (!promise) promise = Promise.resolve().then(schemaFn).catch((err) => { promise = null; throw err; });
            return promise;
        };
    },
    getRedis: () => null,
    redisHealthy: () => false,
    isSqlStateError: (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
});

// auth/datatableAccess pulls in userStore (through permissions and audience)
// and projectStore, and BOTH run their full createSchema at require time. On
// one pglite connection that DDL either fails noisily or fights this suite's
// own transactions for the connection. gradeForPrincipal and synthesizeAccess
// touch neither store — only resolveDatatablePrincipal does, and that is what
// routes/datatables.principal.test.js is for.
mock(path.join(SERVER, 'stores/userStore'), { getUser: async () => null, getAllGroups: async () => [] });
mock(path.join(SERVER, 'stores/projectStore'), {});

// Everything below this line is the real module.
const datatableStore = require('./datatableStore');
const datatableDbStore = require('./datatableDbStore');
const queryCompiler = require('../core/dataEngine/queryCompiler');
const accessFilter = require('../core/dataEngine/accessFilter');
const { migrationPlan } = require('../core/dataEngine/dataModel/migrationPlan');
const { ddlForTable } = require('../core/dataEngine/dataModel/ddl');
const { normalizeFields } = require('../core/dataEngine/dataModel/datatableFields');
const { synthesizeAccess } = require('../auth/datatableAccess');

// The physical schema name is a hash of the scope now, not 'dtorg_' + the id —
// see the schemaFor header in datatableDbStore.js. Every ground-truth read below
// asks the store for the name rather than spelling it out.
const schemaOf = (orgId) => datatableDbStore.schemaNameFor('org', orgId);

const ORG = 'org-integration-a';
const OTHER_ORG = 'org-integration-b';
const OWNER = 'u-owner';
// The metadata store addresses a tenant by a {kind,id} SCOPE; the engine
// addresses the same tenant by that scope's key. Spelled out once here so a
// call site can never quietly hand one where the other belongs.
const SC = datatableStore.orgScope(ORG);
const SK = datatableDbStore.scopeKey(SC);
const OTHER_SC = datatableStore.orgScope(OTHER_ORG);
const OTHER_SK = datatableDbStore.scopeKey(OTHER_SC);

const COLUMNS = [
    { key: 'email', name: 'E-mail', type: 'text' },
    { key: 'status', name: 'Status', type: 'text' },
    { key: 'score', name: 'Score', type: 'number' },
];

let table = null;
let meta = null;

/** The descriptor + access filter pair every compile on this path needs. */
function metaFor(t) {
    return { ...meta, access: synthesizeAccess(t) };
}
const readFilterFor = (t, grade = 'owner') =>
    accessFilter.compileAccessFilter(metaFor(t), grade, { id: OWNER }, 'read', { dialect: 'pg' });

/** Rows straight out of Postgres, bypassing the store — the ground truth. */
async function realRows(orgId, key) {
    const res = await rawQuery(`SELECT * FROM "${schemaOf(orgId)}"."${key}" ORDER BY "id"`);
    return res.rows;
}

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    // The store's OWN createSchema, not a hand-written copy of it.
    await datatableStore.initDB();
});

after(async () => {
    await pg.close();
});

// ── The scenario, in order. Each step depends on the one before it. ─────────

test('create a table: the datatables row and the org model move together', async () => {
    const norm = normalizeFields(COLUMNS, []);
    assert.ok(norm.ok, norm.error);
    table = await datatableStore.createDatatable({
        scope: SC, ownerUserId: OWNER, key: 'customers', name: 'Customers',
        description: 'the customer list', fields: norm.fields,
    });
    assert.strictEqual(table.organizationId, ORG);
    assert.strictEqual(table.rowCount, 0);

    meta = await datatableStore.getTableMeta(SC, table.id);
    assert.ok(meta, 'a table the picker shows but the compiler cannot describe is the half-written pair this transaction exists to prevent');
    assert.deepStrictEqual(meta.fields.map(f => f.key), ['email', 'status', 'score']);
    // The planner matches fields by id; one without one is invisible to it and
    // its column is never created, on a route that still answers 200.
    assert.ok(meta.fields.every(f => typeof f.id === 'string' && f.id.startsWith('fld_')));
});

test('applying the migration really creates the physical table in the org schema', async () => {
    const { model } = await datatableStore.getModel(SC);
    const plan = migrationPlan({ modelVersion: 1, tables: [] }, model, { dialect: 'pg' });
    assert.ok(plan.length, 'a model with a table must produce DDL');
    const out = await datatableDbStore.applyMigration(SK, SK, plan, { targetVersion: 1 });
    assert.ok(out.applied > 0);

    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'customers' ORDER BY ordinal_position`,
        [schemaOf(ORG)],
    );
    assert.deepStrictEqual(cols.rows.map(r => r.column_name),
        ['id', 'created_at', 'updated_at', 'created_by', 'org_id', 'email', 'status', 'score']);
});

test('an INSERT compiled by the query compiler lands, and reads back through the access filter', async () => {
    const ins = queryCompiler.compileInsert(metaFor(table), { email: 'a@b.c', status: 'new', score: 1 },
        { createdBy: OWNER, orgId: ORG, dialect: 'pg' });
    await datatableDbStore.exec(SK, SK, ins.sql, ins.params);
    await datatableStore.bumpAfterWrite(table.id, SC, 1);

    const list = queryCompiler.compileRecordList(metaFor(table), { limit: 50, dialect: 'pg' }, readFilterFor(table));
    const out = await datatableDbStore.query(SK, SK, list.sql, list.params);
    assert.strictEqual(out.rows.length, 1);
    assert.strictEqual(out.rows[0].email, 'a@b.c');
    assert.strictEqual(out.rows[0].score, 1);
    assert.strictEqual(out.rows[0].created_by, OWNER);
});

test('a viewer of an own-scoped table cannot read a row somebody else created', async () => {
    // Not a compile-text assertion: the predicate is ANDed into the statement
    // and Postgres is the thing that decides. `1=1` for a grade that should be
    // scoped would read identically in the SQL and differently here.
    const ownScoped = { ...table, row_scope: 'own' };
    const list = queryCompiler.compileRecordList(
        metaFor(ownScoped), { limit: 50, dialect: 'pg' },
        accessFilter.compileAccessFilter(metaFor(ownScoped), 'viewer', { id: 'u-somebody-else' }, 'read', { dialect: 'pg' }),
    );
    const out = await datatableDbStore.query(SK, SK, list.sql, list.params);
    assert.deepStrictEqual(out.rows, []);
});

test('a caller-supplied filter is ANDed to the access predicate, never substituted for it', async () => {
    // The whole no-SQL design rests on this: the access filter is emitted
    // FIRST and every client filter is appended with AND, so a zero-filter
    // query is still scoped and a filtered one cannot escape the scope.
    const filter = accessFilter.compileAccessFilter(
        metaFor({ ...table, row_scope: 'own' }), 'editor', { id: OWNER }, 'read', { dialect: 'pg' });
    const list = queryCompiler.compileRecordList(metaFor(table), {
        filters: [{ field: 'status', op: 'eq', value: 'new' }], limit: 50, dialect: 'pg',
    }, filter);
    assert.match(list.sql, /WHERE \("created_by" = \?\) AND "status" = \?/);
    assert.deepStrictEqual(list.params.slice(0, 2), [OWNER, 'new']);

    const out = await datatableDbStore.query(SK, SK, list.sql, list.params);
    assert.strictEqual(out.rows.length, 1, 'the owner created this row, so both halves hold');
});

test('save_row on an existing key leaves ONE row, not two', async () => {
    const { execDatatable } = require('../core/automationRunner/execDatatable');
    const ctx = { userId: OWNER, orgId: ORG, userHomeOrgId: ORG, orgRole: 'member', userGroupIds: [] };
    const step = {
        id: 's1', type: 'datatable', op: 'save_row', datatableId: table.id, matchColumn: 'email',
        values: {
            email: { kind: 'literal', value: 'a@b.c' },
            status: { kind: 'literal', value: 'seen' },
        },
    };
    const res = await execDatatable(step, ctx, { trigger: {}, steps: {} }, 'live');
    assert.strictEqual(res.output.created, false, 'the probe must FIND the row the previous step inserted');
    assert.strictEqual(res.output.updated, 1);

    const rows = await realRows(ORG, 'customers');
    assert.strictEqual(rows.length, 1, 'a nightly automation keyed on an e-mail address grew one duplicate per run');
    assert.strictEqual(rows[0].status, 'seen');
});

test('save_row on a NEW key inserts, and the counter follows', async () => {
    const { execDatatable } = require('../core/automationRunner/execDatatable');
    const ctx = { userId: OWNER, orgId: ORG, userHomeOrgId: ORG, orgRole: 'member', userGroupIds: [] };
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'save_row', datatableId: table.id, matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'z@b.c' }, status: { kind: 'literal', value: 'new' } },
    }, ctx, { trigger: {}, steps: {} }, 'live');
    assert.strictEqual(res.output.created, true);
    assert.ok(res.output.id, 'the minted id must come back, or the next run cannot find the row');

    const rows = await realRows(ORG, 'customers');
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.some(r => r.id === res.output.id));
});

test('a filtered update_rows reports the count Postgres actually changed', async () => {
    const { execDatatable } = require('../core/automationRunner/execDatatable');
    const ctx = { userId: OWNER, orgId: ORG, userHomeOrgId: ORG, orgRole: 'member', userGroupIds: [] };
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'update_rows', datatableId: table.id,
        values: { status: { kind: 'literal', value: 'done' } },
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'a@b.c' } }],
    }, ctx, { trigger: {}, steps: {} }, 'live');
    // `changes ? … : 1` counted a 0-row statement as 1. Only a real database
    // can tell the reported number from the true one.
    assert.strictEqual(res.output.updated, 1);

    const rows = await realRows(ORG, 'customers');
    const byEmail = Object.fromEntries(rows.map(r => [r.email, r.status]));
    assert.deepStrictEqual(byEmail, { 'a@b.c': 'done', 'z@b.c': 'new' },
        'exactly the matched row moved — the unmatched one is the assertion');
});

test('delete_rows removes only what it matched, and row_count agrees with COUNT(*)', async () => {
    const { execDatatable } = require('../core/automationRunner/execDatatable');
    const ctx = { userId: OWNER, orgId: ORG, userHomeOrgId: ORG, orgRole: 'member', userGroupIds: [] };
    const res = await execDatatable({
        id: 's1', type: 'datatable', op: 'delete_rows', datatableId: table.id,
        where: [{ field: 'email', op: 'eq', value: { kind: 'literal', value: 'z@b.c' } }],
    }, ctx, { trigger: {}, steps: {} }, 'live');
    assert.strictEqual(res.output.deleted, 1);

    const rows = await realRows(ORG, 'customers');
    assert.deepStrictEqual(rows.map(r => r.email), ['a@b.c']);

    // The counter is a denormalised scalar bumped per write step. It drives the
    // MAX_ROWS_PER_TABLE quota, and GREATEST(0, …) hides an underflow — so a
    // drift here passes the quota check for ever.
    const fresh = await datatableStore.getDatatable(table.id, SC);
    const count = await rawQuery(`SELECT COUNT(*)::int AS n FROM "${schemaOf(ORG)}"."customers"`);
    assert.strictEqual(fresh.rowCount, count.rows[0].n);
});

// ── Companions ──────────────────────────────────────────────────────────────

test('two organisations with the same table key keep separate rows', async () => {
    const norm = normalizeFields(COLUMNS, []);
    const other = await datatableStore.createDatatable({
        scope: OTHER_SC, ownerUserId: OWNER, key: 'customers', name: 'Customers',
        description: 'another org entirely', fields: norm.fields,
    });
    const { model } = await datatableStore.getModel(OTHER_SC);
    await datatableDbStore.applyMigration(OTHER_SK, OTHER_SK,
        migrationPlan({ modelVersion: 1, tables: [] }, model, { dialect: 'pg' }), { targetVersion: 1 });

    const otherMeta = await datatableStore.getTableMeta(OTHER_SC, other.id);
    const ins = queryCompiler.compileInsert({ ...otherMeta, access: synthesizeAccess(other) },
        { email: 'someone@else.example' }, { createdBy: OWNER, orgId: OTHER_ORG, dialect: 'pg' });
    await datatableDbStore.exec(OTHER_SK, OTHER_SK, ins.sql, ins.params);

    // The compiler emits an UNQUALIFIED `"customers"`; the separation is the
    // engine's `SET LOCAL search_path` and nothing else.
    assert.deepStrictEqual((await realRows(ORG, 'customers')).map(r => r.email), ['a@b.c']);
    assert.deepStrictEqual((await realRows(OTHER_ORG, 'customers')).map(r => r.email), ['someone@else.example']);
});

test('a migration statement that throws leaves the schema AND the model unchanged', async () => {
    const before = await datatableStore.getModel(SC);
    const cols = async () => (await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'customers'`, [schemaOf(ORG)])).rows.length;
    const columnsBefore = await cols();

    await assert.rejects(
        () => datatableDbStore.applyMigration(SK, SK, [
            'ALTER TABLE "customers" ADD COLUMN "will_land" TEXT',
            'ALTER TABLE "no_such_table" ADD COLUMN "never" TEXT',
        ], { targetVersion: 99 }),
        // 42701/42P07 are the two tolerant replays; everything else must abort
        // the whole transaction rather than leave half a schema behind.
        (e) => /no_such_table/.test(e.message),
    );
    assert.strictEqual(await cols(), columnsBefore,
        'the first ALTER must have rolled back with the second — a half-applied plan is a schema no model describes');
    const after = await datatableStore.getModel(SC);
    assert.strictEqual(after.modelVersion, before.modelVersion);
});

test('dropDatatable removes the metadata AND the physical table', async () => {
    const norm = normalizeFields([{ key: 'note', name: 'Note', type: 'text' }], []);
    const doomed = await datatableStore.createDatatable({
        scope: SC, ownerUserId: OWNER, key: 'scratch', name: 'Scratch',
        description: 'about to go', fields: norm.fields,
    });
    const { model } = await datatableStore.getModel(SC);
    await datatableDbStore.applyMigration(SK, SK,
        migrationPlan(model, model, { dialect: 'pg' }).concat(
            ddlForTable(model.tables.find(t => t.id === doomed.id), { dialect: 'pg' })),
        { targetVersion: 2 });
    const exists = async () => (await rawQuery(
        `SELECT to_regclass($1) AS t`, [`"${schemaOf(ORG)}"."scratch"`])).rows[0].t;
    assert.ok(await exists(), 'the physical table must exist before the drop proves anything');

    assert.strictEqual(await datatableDbStore.dropDatatable(doomed.id, SC), true);
    // The route used to commit the metadata and only THEN run the DDL, and it
    // answered {ok:true} either way — leaving a Postgres table full of personal
    // data that no metadata described and no UI could reach.
    assert.strictEqual(await exists(), null, 'an orphaned table is un-erasable personal data');
    assert.strictEqual(await datatableStore.getDatatable(doomed.id, SC), null);
    assert.strictEqual(await datatableStore.getTableMeta(SC, doomed.id), null);
});

test('deleting a table of ANOTHER organisation drops nothing', async () => {
    assert.strictEqual(await datatableDbStore.dropDatatable(table.id, OTHER_SC), false);
    assert.deepStrictEqual((await realRows(ORG, 'customers')).map(r => r.email), ['a@b.c'],
        'the DDL must be skipped when no metadata row was deleted');
});
