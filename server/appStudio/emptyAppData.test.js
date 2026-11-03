/**
 * Emptying an app's tables, against a REAL SQLite database with foreign keys on and the DDL the
 * app store really emits: child-first order, the referenced_by refusal, skipped sourced tables,
 * files reaching the purge, and the connectors that get their sync state reset.
 *
 * Run: cd server && node --test appStudio/emptyAppData.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const dataModel = require('./dataModel');
const qc = require('./queryCompiler');
const { emptyAppData, planEmpty } = require('./emptyAppData.mts');

const app = { id: 'app-1', userId: 'owner-1' };

const PARENT = { id: 'tbl_parent0', key: 'parents', name: 'Parents', fields: [{ id: 'fld_p00001', key: 'name', name: 'Name', type: 'text' }] };
const CHILD = { id: 'tbl_child00', key: 'children', name: 'Children', fields: [
    { id: 'fld_c00001', key: 'parent', name: 'Parent', type: 'relation', relation: { table: PARENT.id } },
    { id: 'fld_c00002', key: 'file', name: 'File', type: 'file' },
] };
const GRAND = { id: 'tbl_grand00', key: 'grandchildren', name: 'Grandchildren', fields: [
    { id: 'fld_g00001', key: 'child', name: 'Child', type: 'relation', relation: { table: CHILD.id } },
] };
const TREE = { id: 'tbl_tree000', key: 'tree', name: 'Tree', fields: [
    { id: 'fld_t00001', key: 'up', name: 'Up', type: 'relation', relation: { table: 'tbl_tree000' } },
] };
const EXTERNAL = { id: 'tbl_ext0000', key: 'external', name: 'External', source: { kind: 'datatable', datatableId: 'tbl_abcd1234', mode: 'read' }, fields: [{ id: 'fld_e00001', key: 'x', name: 'X', type: 'text' }] };
const A = { id: 'tbl_cycleA0', key: 'cyc_a', name: 'A', fields: [{ id: 'fld_a00001', key: 'b', name: 'B', type: 'relation', relation: { table: 'tbl_cycleB0' } }] };
const B = { id: 'tbl_cycleB0', key: 'cyc_b', name: 'B', fields: [{ id: 'fld_b00001', key: 'a', name: 'A', type: 'relation', relation: { table: 'tbl_cycleA0' } }] };

function openDb(tables) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const tableKeyById = new Map(tables.map((t) => [t.id, t.key]));
    for (const t of tables) db.exec(dataModel.ddlForTable(t, { tableKeyById, dialect: 'sqlite' }));
    return db;
}
const ins = (db, table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
};
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
const desc = (fileId) => JSON.stringify({ kind: 'studio_attachment', fileId });

function depsOver(db) {
    const calls = { purged: [], counts: [], versions: [], resets: [], batches: 0 };
    return {
        calls,
        deps: {
            batch: async (_o, _a, statements) => {
                calls.batches++;
                return db.transaction(() => statements.map((s) => {
                    const stmt = db.prepare(s.sql);
                    return stmt.readonly ? { rows: stmt.all(...s.params) } : { changes: stmt.run(...s.params).changes };
                }))();
            },
            compileDeleteAll: (t, a) => qc.compileDeleteAll(t, a),
            purgeAttachments: async (ids) => { calls.purged.push(...ids); },
            setRowCount: async (_a, tableKey, n) => { calls.counts.push([tableKey, n]); },
            bumpDataVersion: async (_a, tableKey) => { calls.versions.push(tableKey); },
            resetSyncStates: async (_a, _o, ids) => { calls.resets.push(...ids); return ids.length; },
        },
    };
}

const modelOf = (tables, connectors = []) => ({ tables, connectors });

test('parent, child and grandchild are emptied child-first without a foreign-key error', async () => {
    const db = openDb([PARENT, CHILD, GRAND]);
    ins(db, 'parents', { id: 'p1', name: 'x' });
    ins(db, 'children', { id: 'c1', parent: 'p1', file: desc('f1') });
    ins(db, 'children', { id: 'c2', parent: 'p1', file: desc('f2') });
    ins(db, 'grandchildren', { id: 'g1', child: 'c1' });
    const { deps, calls } = depsOver(db);
    // declared parent-first on purpose: the order is the planner's job
    const res = await emptyAppData(app, modelOf([PARENT, CHILD, GRAND]), undefined, deps);
    assert.deepEqual(res.emptied.map((r) => [r.key, r.rows]), [['grandchildren', 1], ['children', 2], ['parents', 1]]);
    for (const t of ['parents', 'children', 'grandchildren']) assert.equal(count(db, t), 0);
    assert.equal(calls.batches, 1);
    assert.deepEqual(calls.purged.sort(), ['f1', 'f2']);
    assert.equal(res.files, 2);
    assert.deepEqual(calls.counts.map((c) => c[1]), [0, 0, 0]);
    assert.deepEqual(calls.versions.sort(), ['children', 'grandchildren', 'parents']);
});

test('files past the engines\' 10 000-row result cap still reach the purge (paged before the transaction)', async () => {
    const db = openDb([PARENT, CHILD]);
    ins(db, 'parents', { id: 'p1', name: 'x' });
    const insert = db.prepare('INSERT INTO "children" ("id", "parent", "file") VALUES (?, ?, ?)');
    db.transaction(() => { for (let i = 0; i < 10_050; i++) insert.run(`c${String(i).padStart(6, '0')}`, 'p1', desc(`f${i}`)); })();
    const { deps, calls } = depsOver(db);
    // The real engines cap a SELECT at 10 000 rows, inside a batch too.
    const batch = deps.batch;
    deps.batch = async (o, a, statements) => (await batch(o, a, statements)).map((r) => (r.rows ? { rows: r.rows.slice(0, 10_000) } : r));
    deps.query = async (_o, _a, sql, params) => ({ rows: db.prepare(sql).all(...params) });
    const res = await emptyAppData(app, modelOf([PARENT, CHILD]), undefined, deps);
    assert.equal(count(db, 'children'), 0);
    assert.equal(res.files, 10_050);
    assert.equal(new Set(calls.purged).size, 10_050);
});

test('choosing only the parent while a child table is left out is a 409 referenced_by naming the child', async () => {
    const db = openDb([PARENT, CHILD, GRAND]);
    ins(db, 'parents', { id: 'p1', name: 'x' });
    ins(db, 'children', { id: 'c1', parent: 'p1' });
    const { deps } = depsOver(db);
    const res = await emptyAppData(app, modelOf([PARENT, CHILD, GRAND]), [PARENT.id], deps);
    assert.equal(res.status, 409);
    assert.equal(res.code, 'referenced_by');
    assert.deepEqual(res.tables, [{ tableId: PARENT.id, key: 'parents', referencedBy: ['children'] }]);
    assert.equal(count(db, 'parents'), 1, 'nothing was deleted');
});

test('choosing the child and grandchild alone works and leaves the parent', async () => {
    const db = openDb([PARENT, CHILD, GRAND]);
    ins(db, 'parents', { id: 'p1', name: 'x' });
    ins(db, 'children', { id: 'c1', parent: 'p1' });
    ins(db, 'grandchildren', { id: 'g1', child: 'c1' });
    const { deps } = depsOver(db);
    const res = await emptyAppData(app, modelOf([PARENT, CHILD, GRAND]), [CHILD.id, GRAND.id], deps);
    assert.equal(res.emptied.length, 2);
    assert.equal(count(db, 'parents'), 1);
});

test('a self-referencing table is one DELETE', async () => {
    const db = openDb([TREE]);
    ins(db, 'tree', { id: 't1' });
    ins(db, 'tree', { id: 't2', up: 't1' });
    const { deps } = depsOver(db);
    const res = await emptyAppData(app, modelOf([TREE]), undefined, deps);
    assert.deepEqual(res.emptied, [{ tableId: TREE.id, key: 'tree', rows: 2 }]);
});

test('a table backed by an external source is skipped and reported', async () => {
    const db = openDb([PARENT]);
    ins(db, 'parents', { id: 'p1', name: 'x' });
    const { deps } = depsOver(db);
    const res = await emptyAppData(app, modelOf([PARENT, EXTERNAL]), undefined, deps);
    assert.deepEqual(res.skipped, [{ tableId: EXTERNAL.id, key: 'external', reason: 'external_source' }]);
    assert.deepEqual(res.emptied.map((r) => r.key), ['parents']);
});

test('unknown table ids are refused with 400 before anything runs', async () => {
    const db = openDb([PARENT]);
    const { deps, calls } = depsOver(db);
    const res = await emptyAppData(app, modelOf([PARENT]), ['tbl_nope'], deps);
    assert.equal(res.status, 400);
    assert.equal(res.code, 'unknown_tables');
    assert.equal(calls.batches, 0);
});

test('a cycle between two tables is broken by nulling the relation columns, in the same transaction', async () => {
    const db = openDb([A, B]);
    // the two columns point at each other: insert with the checks off, as a real app could have
    db.pragma('foreign_keys = OFF');
    ins(db, 'cyc_a', { id: 'a1', b: 'b1' });
    ins(db, 'cyc_b', { id: 'b1', a: 'a1' });
    db.pragma('foreign_keys = ON');
    const { deps, calls } = depsOver(db);
    const res = await emptyAppData(app, modelOf([A, B]), undefined, deps);
    assert.equal(res.emptied.length, 2);
    assert.equal(count(db, 'cyc_a') + count(db, 'cyc_b'), 0);
    assert.equal(calls.batches, 1);
});

test('a cycle through a required column is refused with 409 relation_cycle', () => {
    const reqA = { ...A, fields: [{ ...A.fields[0], required: true }] };
    const reqB = { ...B, fields: [{ ...B.fields[0], required: true }] };
    const plan = planEmpty(modelOf([reqA, reqB]));
    assert.equal(plan.status, 409);
    assert.equal(plan.code, 'relation_cycle');
});

test('only the connectors that fill an emptied table are reset', async () => {
    const db = openDb([PARENT, CHILD]);
    const connectors = [
        { id: 'conn_main', sync: { tableId: PARENT.id } },
        { id: 'conn_kid', sync: { tableId: 'tbl_other00', children: [{ tableId: CHILD.id }] } },
        { id: 'conn_else', sync: { tableId: 'tbl_other00' } },
        { id: 'conn_nosync' },
    ];
    const first = depsOver(db);
    const res = await emptyAppData(app, modelOf([PARENT, CHILD], connectors), [PARENT.id, CHILD.id], first.deps);
    assert.equal(res.connectorsReset, 2);
    assert.deepEqual(first.calls.resets.sort(), ['conn_kid', 'conn_main']);

    const second = depsOver(db);
    const res2 = await emptyAppData(app, modelOf([PARENT, CHILD], connectors), [CHILD.id], second.deps);
    assert.deepEqual(second.calls.resets, ['conn_kid']);
    assert.equal(res2.connectorsReset, 1);
});
