/**
 * app_query_data: argument rules, paging, dataset behaviour, error mapping.
 * The DB edges are patched on the real store modules (restored afterwards);
 * the query compiler, access filter and read runner run for real.
 *
 * Run: node --test appStudio/builderTools/queryData.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { canonicalizeDataModel } = require('../dataModel');
const { applyQueryData } = require('./dataTools');
const studioAppStore = require('../../stores/studioAppStore');
const studioAppDbStore = require('../../stores/studioAppDbStore');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const datasetCache = require('../datasetCache');
const dataReadRunner = require('../dataReadRunner');

const USER = 'user-1';
const APP = { id: 'app1', userId: USER };

const model = canonicalizeDataModel({
    tables: [{
        id: 'tbl_task01', key: 'tasks', name: 'Tasks', access: { default: 'owner' },
        fields: [{ id: 'fld_ti01', key: 'title', type: 'text' }, { id: 'fld_st01', key: 'status', type: 'select', options: ['todo', 'done'] }],
    }],
}).model;
const wrap = () => ({ appId: APP.id, userId: USER, dataModel: model, datasetIds: [{ id: 'ds_1' }] });

const row = (n) => ({ id: `rec_${n}`, title: `t${n}`, status: 'todo', created_by: USER, org_id: 'org-x', created_at: `2026-01-0${n}T00:00:00Z` });

/** Patch an object's methods for one test, restoring them afterwards. */
async function withPatches(patches, fn) {
    const saved = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, impl] of patches) obj[key] = impl;
    try { return await fn(); } finally { for (const [obj, key, orig] of saved) obj[key] = orig; }
}

function dbReturning(rows, capture) {
    return [
        [studioAppStore, 'getStudioApp', async () => APP],
        [studioAppDbStore, 'query', async (owner, appId, sql, params) => { if (capture) capture.push({ owner, appId, sql, params }); return { rows: rows.map((r) => ({ ...r })) }; }],
    ];
}

test('neither id, or both ids, is a clear error', async () => {
    await withPatches(dbReturning([]), async () => {
        const none = await applyQueryData(wrap(), {});
        assert.match(none.error, /tableId.*datasetId/);
        assert.ok(!/undefined/.test(none.error));
        const both = await applyQueryData(wrap(), { tableId: 'tbl_task01', datasetId: 'ds_1' });
        assert.match(both.error, /not both/);
    });
});

test('limit: invalid values are refused, an over-cap value is clamped and says so', async () => {
    await withPatches(dbReturning([row(1)]), async () => {
        for (const limit of [0, -3, 1.5, 'x']) {
            const r = await applyQueryData(wrap(), { tableId: 'tbl_task01', limit });
            assert.match(r.error, /limit/, `limit ${limit}`);
        }
        const big = await applyQueryData(wrap(), { tableId: 'tbl_task01', limit: 500 });
        assert.strictEqual(big.limitClamped, true);
        assert.strictEqual(big.limit, 20);
    });
});

test('sort.dir other than asc/desc is refused; a valid sort reaches the SQL', async () => {
    const calls = [];
    await withPatches(dbReturning([row(1)], calls), async () => {
        const bad = await applyQueryData(wrap(), { tableId: 'tbl_task01', sort: { field: 'title', dir: 'sideways' } });
        assert.match(bad.error, /dir/);
        const ok = await applyQueryData(wrap(), { tableId: 'tbl_task01', sort: { field: 'title', dir: 'asc' } });
        assert.ok(!ok.error, JSON.stringify(ok));
        assert.match(calls.pop().sql, /ORDER BY[^;]*"title" ASC/i);
    });
});

test('a table page reports more + nextCursor, scoped to the owner and app, without internal ids', async () => {
    const calls = [];
    // limit 2 → the compiler asks for 3 rows; a 3rd row means another page
    await withPatches(dbReturning([row(1), row(2), row(3)], calls), async () => {
        const r = await applyQueryData(wrap(), { tableId: 'tbl_task01', limit: 2 });
        assert.strictEqual(r.rowCount, 2);
        assert.strictEqual(r.more, true);
        assert.ok(typeof r.nextCursor === 'string' && r.nextCursor);
        assert.ok(!('created_by' in r.rows[0]) && !('org_id' in r.rows[0]), JSON.stringify(r.rows[0]));
        assert.strictEqual(calls[0].owner, USER);
        assert.strictEqual(calls[0].appId, APP.id);
        const next = await applyQueryData(wrap(), { tableId: 'tbl_task01', limit: 2, cursor: r.nextCursor });
        assert.ok(!next.error, JSON.stringify(next));
        assert.ok(calls[1].params.length > calls[0].params.length, 'the cursor reached the query');
    });
});

test('a dataset page: rowCount is the page, totalRows the whole, sort/filter refused, paging works', async () => {
    const all = [1, 2, 3, 4, 5].map((n) => ({ status: `s${n}`, n }));
    const patches = [
        [studioAppStore, 'getStudioApp', async () => APP],
        [studioAppDataStore, 'getDataset', async () => ({ id: 'ds_1', tableId: 'tbl_task01', descriptor: {} })],
        [datasetCache, 'runDataset', async () => ({ rows: all })],
    ];
    await withPatches(patches, async () => {
        const p1 = await applyQueryData(wrap(), { datasetId: 'ds_1', limit: 2 });
        assert.strictEqual(p1.rowCount, 2);
        assert.strictEqual(p1.totalRows, 5);
        assert.strictEqual(p1.more, true);
        const p2 = await applyQueryData(wrap(), { datasetId: 'ds_1', limit: 2, cursor: p1.nextCursor });
        assert.deepStrictEqual(p2.rows.map((r) => r.n), [3, 4]);
        const last = await applyQueryData(wrap(), { datasetId: 'ds_1', limit: 2, cursor: p2.nextCursor });
        assert.deepStrictEqual(last.rows.map((r) => r.n), [5]);
        assert.strictEqual(last.more, undefined);
        const refused = await applyQueryData(wrap(), { datasetId: 'ds_1', sort: { field: 'n', dir: 'asc' } });
        assert.match(refused.error, /filter and sort/);
    });
});

test('a database error is generic to the client; a compile error keeps the filter hint', async () => {
    const failing = [
        [studioAppStore, 'getStudioApp', async () => APP],
        [studioAppDbStore, 'query', async () => { throw new Error('relation "synthetic_secret_rel" does not exist'); }],
    ];
    await withPatches(failing, async () => {
        const r = await applyQueryData(wrap(), { tableId: 'tbl_task01' });
        assert.ok(!JSON.stringify(r).includes('synthetic_secret_rel'), JSON.stringify(r));
        assert.strictEqual(r._fixHint, undefined, 'no filter-ops hint for a non-filter failure');
    });
    await withPatches(dbReturning([]), async () => {
        const r = await applyQueryData(wrap(), { tableId: 'tbl_task01', filter: [{ field: 'ghost', op: 'eq', value: 1 }] });
        assert.match(r.error, /unknown field: ghost/);
        assert.ok(r._fixHint);
    });
});

test('rows are an allow-list of the declared fields, and the read runs in the app owner\'s scope', async () => {
    const calls = [];
    const extra = { ...row(1), secret_col: 'x', created_by: 'someone-else' };
    await withPatches(dbReturning([extra], calls), async () => {
        const r = await applyQueryData({ ...wrap(), userId: 'editor-2' }, { tableId: 'tbl_task01' });
        assert.deepStrictEqual(Object.keys(r.rows[0]).sort(), ['created_at', 'id', 'status', 'title']);
        assert.strictEqual(calls[0].owner, USER, 'the app owner, not the editor, scopes the database');
    });
});

test('a linked table goes through the shared runner and keeps linked:true', async () => {
    const linkedModel = { ...model, tables: [{ ...model.tables[0], source: { kind: 'datatable', datatableId: 'dt_synthetic1', mode: 'read' } }] };
    const seen = [];
    const patches = [
        [studioAppStore, 'getStudioApp', async () => APP],
        [dataReadRunner, 'runRecordList', async (ctx, table, o) => { seen.push({ ctx, o }); return { records: [row(1)], nextCursor: 'abc' }; }],
    ];
    await withPatches(patches, async () => {
        const r = await applyQueryData({ ...wrap(), dataModel: linkedModel }, { tableId: 'tbl_task01', limit: 1 });
        assert.strictEqual(r.linked, true);
        assert.strictEqual(r.more, true);
        assert.strictEqual(r.nextCursor, 'abc');
        assert.strictEqual(seen[0].ctx.ownerScope, USER);
        assert.strictEqual(seen[0].o.limit, 1);
    });
});
