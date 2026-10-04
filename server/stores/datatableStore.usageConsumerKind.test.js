'use strict';

/**
 * The dependents index, generalised to every consumer kind — against a REAL
 * Postgres (@electric-sql/pglite, in-process), because the properties that
 * matter are all effects: a column that a pre-existing table gains at boot, a
 * CHECK that is widened once, a DELETE that reaches exactly one consumer's
 * rows, and a JOIN that names an app by its own table.
 *
 * The table is deliberately NOT renamed and its primary key not reshaped —
 * the store header explains why (two-replica rolling deploy, every-boot DDL
 * under the old name). So this suite starts from the table as production has
 * it TODAY, lets the store bring it forward, and checks that the old callers
 * still see what they always saw.
 *
 * Run: cd server && node --test --test-force-exit stores/datatableStore.usageConsumerKind.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

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
mock(path.join(SERVER, 'stores/userStore'), { getUser: async () => null, getAllGroups: async () => [] });
mock(path.join(SERVER, 'stores/projectStore'), {});

// Required INSIDE `before`, after the legacy table exists: the store runs its
// DDL at load time, and the point of this suite is what that DDL does to a
// table that predates it.
let datatableStore = null;
const ORG = 'org-usage-kind';
let SC = null;
let tableId = null;

const one = async (sql, params) => (await rawQuery(sql, params)).rows[0];

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    // The index as production has it today: scoped (datatable-scope-2026-09
    // ran), no consumer_kind, the two-value CHECK. No FK to datatables here —
    // the store creates `datatables` a moment later and the cascade is not
    // under test.
    await pg.exec(`
        CREATE TABLE automation_datatable_usage (
            scope_kind      TEXT NOT NULL DEFAULT 'org',
            scope_id        TEXT,
            organization_id TEXT,
            datatable_id    TEXT NOT NULL,
            automation_id   TEXT NOT NULL,
            step_id         TEXT NOT NULL,
            mode            TEXT NOT NULL CHECK (mode IN ('read','write')),
            columns         JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (automation_id, step_id)
        )
    `);
    // A row written by the OLD code, before the column existed.
    await pg.exec(`INSERT INTO automation_datatable_usage
        (scope_kind, scope_id, organization_id, datatable_id, automation_id, step_id, mode)
        VALUES ('org', '${ORG}', '${ORG}', 'tbl_legacy', 'auto_legacy', 's1', 'read')`);
    // The consumer tables the JOIN reads — only `automations` at first; the
    // other two are created mid-suite to prove the probe.
    await pg.exec(`CREATE TABLE automations (
        id TEXT PRIMARY KEY, user_id TEXT, title TEXT, definition_json JSONB, last_run_at TIMESTAMPTZ)`);

    datatableStore = require('./datatableStore');
    await datatableStore.initDB();
    SC = datatableStore.orgScope(ORG);
    const t = await datatableStore.createDatatable({
        scope: SC, ownerUserId: 'u-owner', key: 'customers', name: 'Customers',
        fields: [{ id: 'f1', key: 'email', name: 'E-mail', type: 'text' }],
    });
    tableId = t.id;
});

after(async () => { await pg.close(); });

// ── The column and the CHECK ────────────────────────────────────────────────

test('a pre-existing index gains consumer_kind, and every old row reads as an automation\'s', async () => {
    const col = await one(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'automation_datatable_usage' AND column_name = 'consumer_kind'`);
    assert.ok(col, 'the column has to be ADDed to a table CREATE TABLE IF NOT EXISTS skipped');
    assert.strictEqual(col.is_nullable, 'NO');
    assert.match(String(col.column_default), /'automation'/);
    const legacy = await one(`SELECT consumer_kind FROM automation_datatable_usage WHERE automation_id = 'auto_legacy'`);
    assert.strictEqual(legacy.consumer_kind, 'automation', 'the default IS the backfill');
});

test('an INSERT that does not know the column — an old replica\'s — still lands as an automation\'s', async () => {
    await rawQuery(`INSERT INTO automation_datatable_usage
        (scope_kind, scope_id, organization_id, datatable_id, automation_id, step_id, mode)
        VALUES ('org', $1, $1, $2, 'auto_old_replica', 's1', 'write')`, [ORG, tableId]);
    const r = await one(`SELECT consumer_kind FROM automation_datatable_usage WHERE automation_id = 'auto_old_replica'`);
    assert.strictEqual(r.consumer_kind, 'automation');
    await rawQuery(`DELETE FROM automation_datatable_usage WHERE automation_id = 'auto_old_replica'`);
});

test('the mode CHECK is widened to readwrite, once, and still refuses garbage', async () => {
    const chk = await one(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'automation_datatable_usage'::regclass AND contype = 'c'`);
    assert.ok(chk, 'the CHECK must not simply be dropped');
    assert.match(chk.def, /readwrite/);
    assert.strictEqual(chk.conname, 'automation_datatable_usage_mode_check');
    const count = await one(
        `SELECT COUNT(*)::int AS n FROM pg_constraint
          WHERE conrelid = 'automation_datatable_usage'::regclass AND contype = 'c'`);
    assert.strictEqual(count.n, 1, 'drop-and-add, not add-beside');
    await assert.rejects(
        () => rawQuery(`INSERT INTO automation_datatable_usage
            (scope_kind, scope_id, datatable_id, automation_id, step_id, mode)
            VALUES ('org', $1, $2, 'auto_bad', 's1', 'bogus')`, [ORG, tableId]),
        /check constraint|violates/i);
});

// ── Reconcile, per kind ─────────────────────────────────────────────────────

test('the old entry point is the generic one with kind automation — same rows, same count', async () => {
    const written = await datatableStore.reconcileUsage('auto_1', SC, [
        { datatableId: tableId, stepId: 's1', mode: 'read', columns: ['email'] },
        { datatableId: tableId, stepId: 's2', mode: 'write' },
    ]);
    assert.strictEqual(written, 2);
    const rows = (await rawQuery(
        `SELECT step_id, mode, consumer_kind FROM automation_datatable_usage WHERE automation_id = 'auto_1' ORDER BY step_id`)).rows;
    assert.deepStrictEqual(rows, [
        { step_id: 's1', mode: 'read', consumer_kind: 'automation' },
        { step_id: 's2', mode: 'write', consumer_kind: 'automation' },
    ]);
    // ...and the generic call with an empty list clears exactly those.
    assert.strictEqual(await datatableStore.reconcileUsageFor('automation', 'auto_1', SC, []), 0);
    assert.strictEqual((await one(`SELECT COUNT(*)::int AS n FROM automation_datatable_usage WHERE automation_id = 'auto_1'`)).n, 0);
});

test('an unknown consumer kind is refused loudly, and a bad mode falls back to read', async () => {
    await assert.rejects(() => datatableStore.reconcileUsageFor('widget', 'w1', SC, []), /consumerKind/);
    await assert.rejects(() => datatableStore.purgeUsageFor('widget', 'w1'), /consumerKind/);
    await datatableStore.reconcileUsageFor('app', 'app_modes', SC, [
        { datatableId: tableId, stepId: 't1', mode: 'readwrite' },
        { datatableId: tableId, stepId: 't2', mode: 'delete_everything' },
    ]);
    const rows = (await rawQuery(
        `SELECT step_id, mode FROM automation_datatable_usage WHERE automation_id = 'app_modes' ORDER BY step_id`)).rows;
    assert.deepStrictEqual(rows, [{ step_id: 't1', mode: 'readwrite' }, { step_id: 't2', mode: 'read' }]);
    await datatableStore.purgeUsageFor('app', 'app_modes');
});

test('a reconcile of one kind never touches another kind\'s rows, even for the same id', async () => {
    // Ids never collide in practice (all UUIDs), so this is the guard for the
    // case that should not happen: an app and an automation sharing an id.
    const shared = 'id-shared-across-kinds';
    await datatableStore.reconcileUsageFor('automation', shared, SC, [{ datatableId: tableId, stepId: 's1', mode: 'read' }]);
    await datatableStore.reconcileUsageFor('app', shared, SC, [{ datatableId: tableId, stepId: 'tbl_x', mode: 'readwrite' }]);
    await datatableStore.reconcileUsageFor('webpage', shared, SC, [{ datatableId: tableId, stepId: 'blk_1', mode: 'read' }]);

    await datatableStore.reconcileUsageFor('app', shared, SC, []);
    const left = (await rawQuery(
        `SELECT consumer_kind FROM automation_datatable_usage WHERE automation_id = $1 ORDER BY consumer_kind`, [shared])).rows;
    assert.deepStrictEqual(left.map(r => r.consumer_kind), ['automation', 'webpage']);

    assert.strictEqual(await datatableStore.purgeUsageFor('webpage', shared), 1);
    assert.strictEqual(await datatableStore.purgeUsageForAutomation(shared), 1);
});

// ── listUsage, joined per kind ──────────────────────────────────────────────

const DEFINITION = {
    schemaVersion: 2,
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    // Authoring order is NOT run order: the edges say note → s_http → s_loop → s_dt.
    steps: [
        { id: 's_dt', type: 'datatable', op: 'add_row', datatableId: 'tbl' },
        { id: 'n1', type: 'note', text: 'hi' },
        { id: 's_http', type: 'http_request', method: 'GET' },
        { id: 's_loop', type: 'loop', body: [{ id: 's_inner', type: 'datatable', op: 'find_rows', datatableId: 'tbl' }] },
    ],
    edges: [
        { from: 'trg', to: 'n1' }, { from: 'n1', to: 's_http' },
        { from: 's_http', to: 's_loop' }, { from: 's_loop', to: 's_dt' },
    ],
};

test('before the app and webpage tables exist, listUsage still answers — with a null title', async () => {
    // studio_apps and webpages are created by their own stores on first use. A
    // JOIN to a missing relation would 500 the used-by tab AND the delete
    // guard on a fresh install that has never opened App Studio.
    await datatableStore.reconcileUsageFor('app', 'app_early', SC, [{ datatableId: tableId, stepId: 'tbl_a', mode: 'readwrite' }]);
    const usage = await datatableStore.listUsage(tableId);
    const row = usage.find(u => u.consumerId === 'app_early');
    assert.ok(row);
    assert.strictEqual(row.consumerKind, 'app');
    assert.strictEqual(row.consumerTitle, null);
    assert.strictEqual(row.mode, 'readwrite');
});

test('each kind is named from its own table, and an automation step carries its position, type and last run', async () => {
    await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, user_id TEXT, name TEXT)');
    await pg.exec('CREATE TABLE webpages (id TEXT PRIMARY KEY, user_id TEXT, name TEXT)');
    await rawQuery(`INSERT INTO automations (id, user_id, title, definition_json, last_run_at)
                    VALUES ('auto_2', 'u-a', 'Nightly sync', $1::jsonb, '2026-09-04T10:00:00Z')`, [JSON.stringify(DEFINITION)]);
    await rawQuery(`INSERT INTO studio_apps (id, user_id, name) VALUES ('app_early', 'u-b', 'Order desk')`);
    await rawQuery(`INSERT INTO webpages (id, user_id, name) VALUES ('page_1', 'u-c', 'Price list')`);

    await datatableStore.reconcileUsage('auto_2', SC, [
        { datatableId: tableId, stepId: 's_dt', mode: 'write', columns: ['email'] },
        { datatableId: tableId, stepId: 's_inner', mode: 'read' },
    ]);
    await datatableStore.reconcileUsageFor('webpage', 'page_1', SC, [{ datatableId: tableId, stepId: 'blk_1', mode: 'read' }]);

    const usage = await datatableStore.listUsage(tableId);
    const by = (id, step) => usage.find(u => u.consumerId === id && u.stepId === step);

    const top = by('auto_2', 's_dt');
    assert.strictEqual(top.consumerKind, 'automation');
    assert.strictEqual(top.consumerTitle, 'Nightly sync');
    assert.strictEqual(top.consumerOwner, 'u-a');
    // Run order, trigger and note skipped: http=1, loop=2, datatable=3.
    assert.strictEqual(top.stepOrdinal, 3);
    assert.strictEqual(top.stepType, 'datatable');
    assert.strictEqual(top.stepOp, 'add_row');
    assert.strictEqual(top.lastRunAt, '2026-09-04T10:00:00.000Z');
    assert.deepStrictEqual(top.columns, ['email']);
    // The legacy names are aliases — the panel, the column-drop and the delete
    // refusals all still read them.
    assert.strictEqual(top.automationId, 'auto_2');
    assert.strictEqual(top.automationTitle, 'Nightly sync');
    assert.strictEqual(top.automationOwner, 'u-a');

    const inner = by('auto_2', 's_inner');
    assert.strictEqual(inner.stepOrdinal, 2, 'a step inside a loop body wears the loop\'s number — the one on the canvas');
    assert.strictEqual(inner.stepOp, 'find_rows');

    const app = by('app_early', 'tbl_a');
    assert.strictEqual(app.consumerKind, 'app');
    assert.strictEqual(app.consumerTitle, 'Order desk');
    assert.strictEqual(app.consumerOwner, 'u-b');
    assert.strictEqual(app.automationTitle, 'Order desk', 'the alias holds for every kind');
    assert.strictEqual(app.stepOrdinal, null);
    assert.strictEqual(app.stepType, null);
    assert.strictEqual(app.lastRunAt, null);

    const page = by('page_1', 'blk_1');
    assert.strictEqual(page.consumerKind, 'webpage');
    assert.strictEqual(page.consumerTitle, 'Price list');
    assert.strictEqual(page.consumerOwner, 'u-c');

    // listUsageForColumn — the destructive-change guard — sees every kind.
    const readers = await datatableStore.listUsageForColumn(tableId, 'email');
    assert.deepStrictEqual(readers.map(r => [r.consumerKind, r.stepId]), [['automation', 's_dt']]);
});

test('listUsageCounts counts CONSUMERS, not steps, and answers 0 for a table nobody uses', async () => {
    const counts = await datatableStore.listUsageCounts([tableId, 'tbl_nobody']);
    // auto_2 (two steps), app_early, page_1 — three consumers.
    assert.strictEqual(counts.get(tableId), 3);
    assert.strictEqual(counts.get('tbl_nobody'), 0);
    assert.strictEqual((await datatableStore.listUsageCounts([])).size, 0);
});

test('purging one kind leaves the others standing', async () => {
    assert.strictEqual(await datatableStore.purgeUsageFor('app', 'app_early'), 1);
    const usage = await datatableStore.listUsage(tableId);
    assert.deepStrictEqual(
        usage.map(u => u.consumerKind).sort(),
        ['automation', 'automation', 'webpage']);
});
