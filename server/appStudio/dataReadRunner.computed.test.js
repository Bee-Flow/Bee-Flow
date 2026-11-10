/**
 * Read-time computed fields through the read paths an app uses (issue 587):
 * the records list and the batch (dataReadRunner), the single-record read
 * (routes/studio/appDataContext readOne) and a server step's data binding
 * (stepDataSource). The per-app store is a real in-memory SQLite; a second
 * store that refuses every computed expression stands in for an engine on
 * which the expression fails.
 *
 * Run: cd server && node --test appStudio/dataReadRunner.computed.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const memdb = new Database(':memory:');
let failComputed = false;
const calls = [];

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params) => {
        calls.push(sql);
        if (failComputed && sql.includes(') AS "')) throw Object.assign(new Error('engine refused'), { code: 'XX000' });
        return { rows: memdb.prepare(sql).all(...params) };
    },
});
stub('../stores/studioAppDataStore', { getMemberRole: async () => null });

const { ddlForTable } = require('../core/dataEngine/dataModel/ddl');
const queryCompiler = require('./queryCompiler');
const dataReadRunner = require('./dataReadRunner');
const { readOne } = require('../routes/studio/appDataContext');
const { resolveDataBinding } = require('./stepDataSource');
const { computedNote } = require('../core/dataEngine/computedRead.mts');

const OWNER = 'u-owner';
const TABLE = {
    id: 'tbl_lines01',
    key: 'lines',
    name: 'Lines',
    fields: [
        { id: 'fld_l1', key: 'item', type: 'text' },
        { id: 'fld_l2', key: 'price', type: 'number' },
        { id: 'fld_l3', key: 'qty', type: 'number', subtype: 'integer' },
        { id: 'fld_l4', key: 'total', type: 'computed', computed: { expr: 'price * qty', type: 'number' } },
        { id: 'fld_l5', key: 'legacy', type: 'computed', computed: { expr: 'iif(qty > 1, 1, 0)' } },
    ],
    access: {
        default: 'none',
        roles: { member: { read: 'own', create: true, update: 'own', delete: 'none' } },
    },
};
const MODEL = { modelVersion: 1, tables: [TABLE], roles: [{ key: 'member' }] };
const APP = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };
const ctxFor = (role, viewerId) => ({
    app: APP, ownerScope: OWNER, viewerId, role, viewer: { id: viewerId, role }, model: MODEL, table: TABLE,
});

memdb.exec(ddlForTable(TABLE, { dialect: 'sqlite' }));
const ids = {};
for (const [item, price, qty, by] of [['pen', 2.5, 4, 'u-member'], ['desk', 120, 1, OWNER]]) {
    const ins = queryCompiler.compileInsert(TABLE, { item, price, qty, total: 999 }, { createdBy: by, dialect: 'sqlite' });
    memdb.prepare(ins.sql).run(...ins.params);
    ids[item] = ins.id;
}

test.beforeEach(() => { failComputed = false; calls.length = 0; });

test('the records list evaluates a read-time computed field and names the one that reads empty', async () => {
    const out = await dataReadRunner.runRecordList(ctxFor('owner', OWNER), TABLE, { sort: { field: 'item', dir: 'asc' } });
    assert.deepEqual(out.records.map((r) => [r.item, r.total, r.legacy]), [['desk', 120, null], ['pen', 10, null]]);
    assert.deepEqual(out.notes, [computedNote('legacy')]);
});

test('a member reads only own rows, computed included', async () => {
    const out = await dataReadRunner.runRecordList(ctxFor('member', 'u-member'), TABLE, {});
    assert.deepEqual(out.records.map((r) => [r.item, r.total]), [['pen', 10]]);
    assert.ok(calls[0].includes('"created_by" = ?'), 'the row rule is in the read');
});

test('a batch read answers with the same values', async () => {
    const [res] = await dataReadRunner.runBatch(ctxFor('owner', OWNER), [{ id: 'b1', kind: 'records', tableId: TABLE.id, filters: [{ field: 'item', op: 'eq', value: 'pen' }] }]);
    assert.equal(res.ok, true);
    assert.equal(res.data.records[0].total, 10);
});

test('the single-record read evaluates it, and a hidden row stays hidden', async () => {
    assert.equal((await readOne(ctxFor('owner', OWNER), ids.desk)).total, 120);
    assert.equal(await readOne(ctxFor('member', 'u-member'), ids.desk), null);
});

test('a server step data binding sees the value', async () => {
    const row = await resolveDataBinding(APP, MODEL, { kind: 'record', tableId: TABLE.id, filter: [{ field: 'item', op: 'eq', value: 'desk' }] },
        { viewer: { id: OWNER }, role: 'owner' });
    assert.equal(row.total, 120);
});

test('when the engine fails the expression, every read path still answers, with the computed fields empty', async () => {
    failComputed = true;
    const list = await dataReadRunner.runRecordList(ctxFor('owner', OWNER), TABLE, {});
    assert.equal(list.records.length, 2);
    assert.ok(list.records.every((r) => r.total === null && r.legacy === null));
    assert.deepEqual(list.notes, [computedNote('total'), computedNote('legacy')]);
    assert.equal((await readOne(ctxFor('owner', OWNER), ids.pen)).total, null);
    const row = await resolveDataBinding(APP, MODEL, { kind: 'record', tableId: TABLE.id, filter: [{ field: 'item', op: 'eq', value: 'pen' }] },
        { viewer: { id: OWNER }, role: 'owner' });
    assert.equal(row.item, 'pen');
    assert.equal(row.total, null);
});
