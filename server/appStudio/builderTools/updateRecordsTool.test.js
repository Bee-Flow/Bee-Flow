/**
 * app_update_records against a REAL in-memory SQLite: the real query compiler, the real RLS
 * gateway and the real writeRecord choke point. Only the stores (Postgres) are replaced by
 * thin stand-ins that run the compiled SQL on the database, via the require cache.
 *
 * Run: cd server && node --test appStudio/builderTools/updateRecordsTool.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };
const db = new Database(':memory:');
const members = new Map(); // userId -> role key
const execLog = [];

const norm = (params) => params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
// The three Postgres-backed stores are loaded for real and their methods swapped for stand-ins that
// run the compiled SQL on the database above; the originals come back when the file is done.
const dbStore = require('../../stores/studioAppDbStore');
const dataStore = require('../../stores/studioAppDataStore');
const appStore = require('../../stores/studioAppStore');
const swaps = [
    [dbStore, {
        exec: async (_owner, _app, sql, params) => { execLog.push(sql); return { changes: db.prepare(sql).run(...norm(params)).changes }; },
        query: async (_owner, _app, sql, params) => ({ rows: db.prepare(sql).all(...norm(params)) }),
        sizeBytes: async () => 0,
    }],
    [dataStore, {
        bumpDataVersion: async () => 1,
        bumpRowCount: async () => ({}),
        getRowCounts: async () => ({}),
        getMemberRole: async (_appId, userId) => members.get(userId) || null,
    }],
    [appStore, { getStudioApp: async (id) => (id === app.id ? app : null) }],
];
const originals = swaps.map(([target, methods]) => [target, Object.fromEntries(Object.keys(methods).map((k) => [k, target[k]]))]);
swaps.forEach(([target, methods]) => Object.assign(target, methods));
test.after(() => originals.forEach(([target, saved]) => Object.assign(target, saved)));

const dataModel = require('../dataModel');
const { applyToolCall, MUTATING_TOOLS, DATA_MODEL_TOOLS } = require('../builderTools');
const { applyUpdateRecords } = require('./updateRecordsTool.mts');

const TASKS = {
    id: 'tbl_tasks0', key: 'tasks', name: 'Tasks',
    fields: [
        { id: 'fld_title0', key: 'title', name: 'Title', type: 'text' },
        { id: 'fld_status', key: 'status', name: 'Status', type: 'text' },
        { id: 'fld_amount', key: 'amount', name: 'Amount', type: 'number', subtype: 'integer' },
    ],
    access: {
        default: 'none',
        roles: {
            seller: { read: 'all', create: true, update: 'own', delete: 'none' },
            viewer: { read: 'all', create: false, update: 'none', delete: 'none' },
        },
        rowFilters: {},
    },
};
const LINKED = { id: 'tbl_linked', key: 'linked', name: 'Linked', fields: [{ id: 'fld_lk0000', key: 'name', name: 'Name', type: 'text' }], source: { kind: 'datatable', datatableId: 'dt_1', mode: 'readwrite' } };
const MODEL = { modelVersion: 1, roles: [{ key: 'seller' }, { key: 'viewer' }], roleMapping: { default: null, byGroup: {} }, tables: [TASKS, LINKED] };

db.exec(dataModel.ddlForTable(TASKS, { tableKeyById: new Map(), dialect: 'sqlite' }));

function reseed() {
    db.exec('DELETE FROM "tasks"');
    const ins = db.prepare('INSERT INTO "tasks" (id, created_at, updated_at, created_by, org_id, title, status, amount) VALUES (?,?,?,?,?,?,?,?)');
    const ts = (n) => `2026-01-0${n}T00:00:00.000Z`;
    ins.run('rec_a1', ts(1), ts(1), 'alice', 'org-1', 'A1', 'open', 10);
    ins.run('rec_a2', ts(2), ts(2), 'alice', 'org-1', 'A2', 'open', 20);
    ins.run('rec_b1', ts(3), ts(3), 'bob', 'org-1', 'B1', 'open', 30);
    ins.run('rec_b2', ts(4), ts(4), 'bob', 'org-1', 'B2', 'done', 40);
    ins.run('rec_b3', ts(5), ts(5), 'bob', 'org-1', 'B3', 'open', 50);
    execLog.length = 0;
}
const row = (id) => db.prepare('SELECT * FROM "tasks" WHERE id = ?').get(id);
const statuses = () => Object.fromEntries(db.prepare('SELECT id, status FROM "tasks"').all().map((r) => [r.id, r.status]));
const wrap = (userId, model = MODEL) => ({ userId, orgId: 'org-1', appId: app.id, dataModel: model });

test.beforeEach(() => { reseed(); members.clear(); members.set('alice', 'seller'); members.set('bob', 'seller'); members.set('vera', 'viewer'); });

test('by id: the owner updates rows; a bad row fails alone with its own error', async () => {
    const out = await applyUpdateRecords(wrap(OWNER), {
        tableId: 'tbl_tasks0',
        updates: [
            { id: 'rec_a1', values: { status: 'done', amount: 11 } },
            { id: 'rec_a2', values: { no_such_field: 'x' } },
            { id: 'rec_missing', values: { status: 'done' } },
            { id: 'rec_b1', values: {} },
            { id: 'rec_a1', values: { status: 'again' } },
        ],
    });
    assert.equal(out.error, undefined);
    assert.equal(out.updated, 1);
    assert.equal(row('rec_a1').status, 'done');
    assert.equal(row('rec_a1').amount, 11);
    const byId = (id) => out.results.filter((r) => r.id === id);
    assert.equal(byId('rec_a1')[0].ok, true);
    assert.equal(byId('rec_a2')[0].ok, false);
    assert.match(byId('rec_a2')[0].error, /no_such_field|unknown/i);
    assert.equal(byId('rec_missing')[0].ok, false);
    assert.match(byId('rec_missing')[0].error, /does not exist|outside/);
    assert.equal(row('rec_a2').status, 'open', 'a rejected row is not written');
    const rejected = out.results.filter((r) => r.index !== undefined);
    assert.equal(rejected.length, 2, 'the empty values and the repeated id are reported by index');
});

test('RLS: a seller changes their own row and is refused on another seller\'s row', async () => {
    const out = await applyUpdateRecords(wrap('alice'), {
        tableId: 'tbl_tasks0',
        updates: [{ id: 'rec_a1', values: { status: 'mine' } }, { id: 'rec_b1', values: { status: 'stolen' } }],
    });
    assert.equal(out.updated, 1);
    assert.deepEqual(out.results.map((r) => [r.id, r.ok]), [['rec_a1', true], ['rec_b1', false]]);
    assert.equal(row('rec_a1').status, 'mine');
    assert.equal(row('rec_b1').status, 'open', 'the other seller\'s row is untouched');
});

test('RLS: a role without update rights, and a caller without any role, change nothing', async () => {
    const viewer = await applyUpdateRecords(wrap('vera'), { tableId: 'tbl_tasks0', updates: [{ id: 'rec_a1', values: { status: 'x' } }] });
    assert.ok(viewer.error);
    const stranger = await applyUpdateRecords(wrap('nobody'), { tableId: 'tbl_tasks0', updates: [{ id: 'rec_a1', values: { status: 'x' } }] });
    assert.match(stranger.error, /no role/);
    assert.equal(execLog.length, 0, 'no statement ran');
});

test('limits: more than 25 rows, none, both forms and an unknown table are refused', async () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ id: `rec_${i}`, values: { status: 'x' } }));
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', updates: many })).error, /at most 25/);
    assert.ok((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', updates: [] })).error);
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0' })).error, /either/);
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', updates: [{ id: 'rec_a1', values: { status: 'x' } }], filter: [{ field: 'status', op: 'eq', value: 'open' }] })).error, /either/);
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_nope', updates: [{ id: 'rec_a1', values: { status: 'x' } }] })).error, /Unknown tableId/);
    assert.equal(execLog.length, 0);
});

test('a linked table is refused in both forms', async () => {
    const a = await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_linked', updates: [{ id: 'rec_1', values: { name: 'x' } }] });
    const b = await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_linked', filter: [{ field: 'name', op: 'eq', value: 'x' }], values: { name: 'y' }, dry_run: false });
    assert.match(a.error, /LINKED/);
    assert.match(b.error, /LINKED/);
});

test('filter: dry_run is the default, reports the count and the first ids and writes nothing', async () => {
    const before = statuses();
    const out = await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'eq', value: 'open' }], values: { status: 'archived' } });
    assert.equal(out.dry_run, true);
    assert.equal(out.matched, 4);
    assert.equal(out.wouldUpdate, 4);
    assert.deepEqual(out.ids, ['rec_a1', 'rec_a2', 'rec_b1', 'rec_b3']);
    assert.deepEqual(statuses(), before);
    assert.equal(execLog.filter((s) => /^\s*UPDATE/i.test(s)).length, 0);
});

test('filter: a real run respects max and reports what was left', async () => {
    const out = await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'eq', value: 'open' }], values: { status: 'archived' }, max: 2, dry_run: false });
    assert.equal(out.matched, 4);
    assert.equal(out.updated, 2);
    assert.equal(out.capped, true);
    assert.deepEqual(Object.values(statuses()).filter((s) => s === 'archived').length, 2);
    assert.equal(row('rec_a1').status, 'archived');
    assert.equal(row('rec_b1').status, 'open');
});

test('filter: a real run is bound by RLS per row (a seller only changes their own)', async () => {
    const out = await applyUpdateRecords(wrap('alice'), { tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'eq', value: 'open' }], values: { status: 'archived' }, dry_run: false });
    assert.equal(out.matched, 4, 'alice may READ every open row');
    assert.equal(out.updated, 2, 'but only her two are updated');
    assert.equal(out.failed, 2);
    const s = statuses();
    assert.equal(s.rec_a1, 'archived');
    assert.equal(s.rec_a2, 'archived');
    assert.equal(s.rec_b1, 'open');
    assert.equal(s.rec_b3, 'open');
});

test('filter: bad input is refused (unknown column, empty filter, max out of range, no values)', async () => {
    const f = [{ field: 'status', op: 'eq', value: 'open' }];
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', filter: [{ field: 'nope', op: 'eq', value: 1 }], values: { status: 'x' } })).error, /Filter failed/);
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', filter: [], values: { status: 'x' } })).error, /filter/);
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'bogus' }], values: { status: 'x' } })).error, /op/);
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', filter: f, values: { status: 'x' }, max: 201 })).error, /max/);
    assert.match((await applyUpdateRecords(wrap(OWNER), { tableId: 'tbl_tasks0', filter: f, values: {} })).error, /values/);
    assert.equal(execLog.filter((s) => /^\s*UPDATE/i.test(s)).length, 0);
});

test('the tool is registered as a data-model writer and reachable through the dispatcher', async () => {
    assert.ok(MUTATING_TOOLS.has('app_update_records'));
    assert.ok(DATA_MODEL_TOOLS.has('app_update_records'));
    const out = await applyToolCall('app_update_records', { tableId: 'tbl_tasks0', updates: [{ id: 'rec_a1', values: { status: 'via dispatcher' } }] }, wrap(OWNER));
    assert.equal(out.updated, 1);
    assert.equal(row('rec_a1').status, 'via dispatcher');
});
