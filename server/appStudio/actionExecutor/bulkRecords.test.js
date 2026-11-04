/**
 * update_record / delete_record in FILTER mode (package 5) against a REAL in-memory SQLite: the
 * real query compiler, the real RLS gateway, the real dispatcher. Only the Postgres-backed stores
 * are swapped for stand-ins that run the compiled SQL on the database.
 *
 * Run: cd server && node --test appStudio/actionExecutor/bulkRecords.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };
const db = new Database(':memory:');
const bumps = [];

const norm = (params) => params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
const dbStore = require('../../stores/studioAppDbStore');
const dataStore = require('../../stores/studioAppDataStore');
const swaps = [
    [dbStore, {
        exec: async (_o, _a, sql, params) => ({ changes: db.prepare(sql).run(...norm(params)).changes }),
        query: async (_o, _a, sql, params) => ({ rows: db.prepare(sql).all(...norm(params)) }),
        batch: async (_o, _a, statements) => db.transaction(() => statements.map((s, i) => {
            if (/^\s*select/i.test(s.sql)) return { rows: db.prepare(s.sql).all(...norm(s.params)) };
            const changes = db.prepare(s.sql).run(...norm(s.params)).changes;
            if (s.expectChanges && !changes) throw Object.assign(new Error('no rows'), { code: 'batch_no_rows', statementIndex: i });
            return { changes };
        }))(),
        sizeBytes: async () => 0,
    }],
    [dataStore, {
        bumpDataVersion: async (_id, key) => { bumps.push(['version', key]); return 1; },
        bumpRowCount: async (_id, key, delta) => { bumps.push(['count', key, delta]); return {}; },
        getRowCounts: async () => ({}),
    }],
];
const originals = swaps.map(([target, methods]) => [target, Object.fromEntries(Object.keys(methods).map((k) => [k, target[k]]))]);
swaps.forEach(([target, methods]) => Object.assign(target, methods));
test.after(() => originals.forEach(([target, saved]) => Object.assign(target, saved)));

const dataModel = require('../dataModel');
const { executeDataStep } = require('./dispatch');
const { previewMatching } = require('./bulkRecords.mts');
const { transactionStep } = require('./transactionStep.mts');

const TASKS = {
    id: 'tbl_tasks0', key: 'tasks', name: 'Tasks',
    fields: [
        { id: 'fld_title0', key: 'title', name: 'Title', type: 'text' },
        { id: 'fld_status', key: 'status', name: 'Status', type: 'text' },
        { id: 'fld_owner0', key: 'owner', name: 'Owner', type: 'text' },
    ],
    access: {
        default: 'none',
        roles: {
            seller: { read: 'all', create: true, update: 'own', delete: 'own' },
            viewer: { read: 'all', create: false, update: 'all', delete: 'none' },
        },
        rowFilters: {},
    },
};
const MODEL = { modelVersion: 1, roles: [{ key: 'seller' }, { key: 'viewer' }], tables: [TASKS] };
db.exec(dataModel.ddlForTable(TASKS, { tableKeyById: new Map(), dialect: 'sqlite' }));

function reseed() {
    db.exec('DELETE FROM "tasks"');
    const ins = db.prepare('INSERT INTO "tasks" (id, created_at, updated_at, created_by, org_id, title, status, owner) VALUES (?,?,?,?,?,?,?,?)');
    const ts = (n) => `2026-01-0${n}T00:00:00.000Z`;
    ins.run('rec_1', ts(1), ts(1), 'alice', 'org-1', 'T1', 'done', null);
    ins.run('rec_2', ts(2), ts(2), 'alice', 'org-1', 'T2', 'open', 'x');
    ins.run('rec_3', ts(3), ts(3), 'bob', 'org-1', 'T3', 'done', null);
    ins.run('rec_4', ts(4), ts(4), 'bob', 'org-1', 'T4', 'open', 'y');
    ins.run('rec_5', ts(5), ts(5), 'alice', 'org-1', 'T5', 'done', 'z');
    ins.run('rec_6', ts(6), ts(6), 'bob', 'org-1', 'T6', 'open', null);
    bumps.length = 0;
}
const ids = () => db.prepare('SELECT id FROM "tasks" ORDER BY id').all().map((r) => r.id);
const statusOf = (id) => db.prepare('SELECT status FROM "tasks" WHERE id = ?').get(id)?.status;
const ownerCtx = (extra = {}) => ({ viewerId: OWNER, viewer: { id: OWNER }, role: 'owner', ...extra });
// The owner's role is 'owner' (rlsGateway.resolveViewerRole): full access.
const asRole = (userId, role, extra = {}) => ({ viewerId: userId, viewer: { id: userId }, role, ...extra });
const DONE = [{ field: 'status', op: 'eq', value: 'done' }];

test.beforeEach(reseed);

test('spec: delete_record with a filter deletes exactly the matching rows', async () => {
    const res = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: DONE }, ownerCtx());
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.bulk, true);
    assert.equal(res.result.matched, 3);
    assert.equal(res.result.deleted, 3);
    assert.equal(res.result.remaining, 0);
    assert.deepEqual([...res.result.ids].sort(), ['rec_1', 'rec_3', 'rec_5']);
    assert.deepEqual(ids(), ['rec_2', 'rec_4', 'rec_6'], 'only the matching rows are gone');
    assert.deepEqual(bumps, [['version', 'tasks'], ['count', 'tasks', -3]], 'bookkeeping once, by the net change');
});

test('limit: the oldest rows change first and the rest is reported as remaining', async () => {
    const res = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: DONE, limit: 2 }, ownerCtx());
    assert.equal(res.ok, true);
    assert.equal(res.result.matched, 3);
    assert.equal(res.result.deleted, 2);
    assert.equal(res.result.remaining, 1);
    assert.deepEqual(res.result.ids, ['rec_1', 'rec_3']);
    assert.ok(res.notes.some((n) => /1 more rows match; limit 2/.test(n)), res.notes);
    assert.deepEqual(ids(), ['rec_2', 'rec_4', 'rec_5', 'rec_6']);
});

test('a limit above the cap is clamped to 500', async () => {
    const { clampBulkLimit } = require('../../core/dataEngine/queryCompilerBulk.mts');
    assert.equal(clampBulkLimit(5000), 500);
    assert.equal(clampBulkLimit(undefined), 500);
    assert.equal(clampBulkLimit(0), 500);
    assert.equal(clampBulkLimit('7'), 7);
});

test('an empty filter value never widens: nothing changes and a note says which field', async () => {
    const step = { kind: 'delete_record', tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'form.missing' } }] };
    const res = await executeDataStep(app, MODEL, step, ownerCtx({ formValues: {} }));
    assert.equal(res.ok, true);
    assert.equal(res.result.deleted, 0);
    assert.equal(ids().length, 6, 'no row was deleted');
    assert.match(res.notes[0], /filter value for "status" was empty/);
    // An empty clause list is refused outright: it would mean every row.
    const empty = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: [] }, ownerCtx());
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'bulk_filter_empty');
    assert.equal(ids().length, 6);
    // A formula-string filter cannot be compiled on the server.
    const str = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: 'status == "done"' }, ownerCtx());
    assert.equal(str.ok, false);
    assert.equal(str.code, 'filter_invalid');
    assert.equal(ids().length, 6);
});

test('isNull takes no value and is kept', async () => {
    const res = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: [{ field: 'owner', op: 'isNull' }] }, ownerCtx());
    assert.equal(res.ok, true);
    assert.equal(res.result.deleted, 3);
    assert.deepEqual(ids(), ['rec_2', 'rec_4', 'rec_5']);
});

test('update_record with a filter sets the values on every matching row', async () => {
    const step = { kind: 'update_record', tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.from' } }], values: { status: { kind: 'static', value: 'archived' } } };
    const res = await executeDataStep(app, MODEL, step, ownerCtx({ vars: { from: 'open' } }));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.updated, 3);
    assert.equal(statusOf('rec_2'), 'archived');
    assert.equal(statusOf('rec_4'), 'archived');
    assert.equal(statusOf('rec_1'), 'done', 'a row outside the filter is untouched');
    assert.deepEqual(bumps, [['version', 'tasks']], 'an update bumps the version, not the count');
});

test('zero matches is a success with zeros', async () => {
    const res = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'eq', value: 'nope' }] }, ownerCtx());
    assert.equal(res.ok, true);
    assert.deepEqual({ matched: res.result.matched, deleted: res.result.deleted, remaining: res.result.remaining }, { matched: 0, deleted: 0, remaining: 0 });
    assert.deepEqual(bumps, []);
});

test('an unknown filter field fails with the compiler sentence, nothing changed', async () => {
    const res = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: [{ field: 'nope', op: 'eq', value: 1 }] }, ownerCtx());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'filter_invalid');
    assert.match(res.error, /nope/);
    assert.equal(ids().length, 6);
});

test('row access: a seller with delete "own" only deletes their own matching rows', async () => {
    const res = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: DONE }, asRole('alice', 'seller'));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.matched, 2, 'bob\'s done row is outside alice\'s write scope');
    assert.deepEqual(ids(), ['rec_2', 'rec_3', 'rec_4', 'rec_6']);
});

test('row access: a role with delete "none" is refused, nothing changed', async () => {
    const res = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: DONE }, asRole('vera', 'viewer'));
    assert.equal(res.ok, false);
    assert.equal(ids().length, 6);
});

test('the matching uses the WRITE scope of the op, not the read scope', async () => {
    // seller reads 'all' but updates 'own': the update must not reach bob's rows.
    const step = { kind: 'update_record', tableId: 'tbl_tasks0', filter: DONE, values: { status: { kind: 'static', value: 'x' } } };
    const res = await executeDataStep(app, MODEL, step, asRole('bob', 'seller'));
    assert.equal(res.ok, true);
    assert.equal(res.result.updated, 1);
    assert.equal(statusOf('rec_3'), 'x');
    assert.equal(statusOf('rec_1'), 'done');
    assert.equal(statusOf('rec_5'), 'done');
});

test('the one-row path is unchanged: a missing recordId is still "Record not found"', async () => {
    const res = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', recordId: { kind: 'static', value: 'rec_missing' } }, ownerCtx());
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Record not found');
    const one = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', recordId: { kind: 'static', value: 'rec_1' } }, ownerCtx());
    assert.deepEqual(one, { ok: true, result: { id: 'rec_1', deleted: true, changes: 1 } });
});

test('previewMatching counts without writing', async () => {
    const out = await previewMatching(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: DONE, limit: 2 }, ownerCtx());
    assert.deepEqual(out, { matched: 3, wouldAffect: 2, limit: 2 });
    assert.equal(ids().length, 6);
    const blocked = await previewMatching(app, MODEL, { kind: 'delete_record', tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.x' } }] }, ownerCtx());
    assert.equal(blocked.blocked, 'status');
});

test('transaction: a filter-mode child sees a row created earlier in the same batch, and rolls back with it', async () => {
    const step = {
        kind: 'transaction',
        steps: [
            { kind: 'create_record', tableId: 'tbl_tasks0', values: { title: { kind: 'static', value: 'new' }, status: { kind: 'static', value: 'temp' } } },
            { kind: 'delete_record', tableId: 'tbl_tasks0', filter: [{ field: 'status', op: 'eq', value: 'temp' }], resultVar: 'gone' },
        ],
    };
    const res = await transactionStep(app, MODEL, step, ownerCtx());
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.results[1].changed, 1, 'the child deleted the row the first child created');
    assert.equal(res.result.vars.gone.changed, 1);
    assert.equal(ids().length, 6);

    // A later child fails: the filter delete is rolled back with everything else.
    const failing = {
        kind: 'transaction',
        steps: [
            { kind: 'delete_record', tableId: 'tbl_tasks0', filter: DONE },
            { kind: 'update_record', tableId: 'tbl_tasks0', recordId: { kind: 'static', value: 'rec_missing' }, values: { status: { kind: 'static', value: 'x' } } },
        ],
    };
    const bad = await transactionStep(app, MODEL, failing, ownerCtx());
    assert.equal(bad.ok, false);
    assert.equal(ids().length, 6, 'nothing was deleted');
});
