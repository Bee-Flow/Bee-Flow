/**
 * datasetCache.runDataset with dataset parameters, against the REAL
 * queryCompiler and rlsGateway on an in-memory engine (only the two stores'
 * functions are replaced).
 *
 * Asserts:
 *   - a dataset WITHOUT declared params keeps its cache key and its SQL, and
 *     ignores whatever params are sent;
 *   - a dataset WITH params compiles the sent values as bound values, keys the
 *     cache per value set, falls back to a default, refuses a misfit value
 *     (400, client-safe) and answers no rows for an unset required clause;
 *   - the viewer's row rules still apply on top of the parameter;
 *   - only a parameterised dataset asks the store to cap its cache rows.
 *
 * Run: cd server && node --test appStudio/datasetCache.params.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const memdb = new Database(':memory:');
memdb.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, created_by TEXT, org_id TEXT,
    title TEXT, region TEXT, amount INTEGER
)`);

// The two stores are replaced by patching their exported functions (restored
// after the file), so datasetCache runs unchanged against the real compiler.
const studioAppDbStore = require('../stores/studioAppDbStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const dbCalls = [];
const cacheRows = new Map();
const putCalls = [];
const patches = {
    db: { query: async (ownerId, appId, sql, params = []) => {
        dbCalls.push({ sql, params });
        return { rows: memdb.prepare(sql).all(...params), columns: [], truncated: false };
    } },
    data: {
        getDataModel: async () => ({ dataVersions: { tasks: 1 } }),
        getCache: async (datasetId, viewerScopeKey, paramsHash) => {
            const row = cacheRows.get(`${datasetId}|${viewerScopeKey}|${paramsHash}`);
            return row ? { result: row } : null;
        },
        putCache: async (datasetId, opts) => {
            putCalls.push({ datasetId, ...opts });
            cacheRows.set(`${datasetId}|${opts.viewerScopeKey}|${opts.paramsHash}`, opts.result);
            return { ok: true };
        },
    },
};
const originals = { db: { query: studioAppDbStore.query }, data: Object.fromEntries(Object.keys(patches.data).map((k) => [k, studioAppDataStore[k]])) };
Object.assign(studioAppDbStore, patches.db);
Object.assign(studioAppDataStore, patches.data);
test.after(() => { Object.assign(studioAppDbStore, originals.db); Object.assign(studioAppDataStore, originals.data); });

const datasetCache = require('./datasetCache');

const APP = { id: 'app-1', userId: 'owner-1' };
const MODEL = {
    roles: [{ key: 'manager' }, { key: 'member' }],
    roleMapping: { default: null, byGroup: {} },
    tables: [{
        id: 'tbl_tasks0', key: 'tasks', name: 'Tasks',
        fields: [
            { id: 'fld_title', key: 'title', type: 'text' },
            { id: 'fld_region', key: 'region', type: 'text' },
            { id: 'fld_amount', key: 'amount', type: 'number', subtype: 'integer' },
        ],
        access: { default: 'none', roles: { manager: { read: 'all' }, member: { read: 'own' } }, rowFilters: {} },
    }],
};
const SUM = [{ fn: 'sum', field: 'amount', as: 'total' }];
const PLAIN = { id: 'ds-plain', tableId: 'tbl_tasks0', descriptor: { aggregates: SUM, filters: [{ field: 'region', op: 'eq', value: 'EU' }] } };
const PARAM = {
    id: 'ds-param', tableId: 'tbl_tasks0',
    descriptor: {
        params: [{ name: 'region', type: 'text', default: 'EU' }, { name: 'min', type: 'number' }],
        aggregates: SUM,
        filters: [{ field: 'region', op: 'eq', value: { param: 'region' } }, { field: 'amount', op: 'gte', value: { param: 'min' } }],
    },
};
const REQUIRED = {
    id: 'ds-req', tableId: 'tbl_tasks0',
    descriptor: { params: [{ name: 'region' }], aggregates: SUM, filters: [{ field: 'region', op: 'eq', value: { param: 'region' }, required: true }] },
};
const mgr = { id: 'mgr', role: 'manager' };
const alice = { id: 'alice', role: 'member' };

function seed(id, by, region, amount) {
    memdb.prepare('INSERT INTO tasks (id, created_by, region, amount) VALUES (?,?,?,?)').run(id, by, region, amount);
}

test.beforeEach(() => {
    dbCalls.length = 0; putCalls.length = 0; cacheRows.clear();
    memdb.exec('DELETE FROM tasks');
    seed('a1', 'alice', 'EU', 10);
    seed('a2', 'alice', 'US', 20);
    seed('b1', 'bob', 'EU', 100);
    seed('b2', 'bob', 'US', 3);
});

const total = (out) => out.rows[0].total;

test('a dataset without declared params: same key, same SQL, sent params ignored', async () => {
    const plainOut = await datasetCache.runDataset(APP, MODEL, PLAIN, mgr, { refresh: true });
    const sentOut = await datasetCache.runDataset(APP, MODEL, PLAIN, mgr, { refresh: true, params: { region: 'US', anything: 1 } });
    assert.strictEqual(total(plainOut), 110);
    assert.strictEqual(total(sentOut), 110);
    assert.strictEqual(dbCalls[0].sql, dbCalls[1].sql);
    assert.deepStrictEqual(dbCalls[0].params, dbCalls[1].params);
    const expected = datasetCache.computeParamsHash('tasks', PLAIN.descriptor);
    assert.strictEqual(putCalls[0].paramsHash, expected);
    assert.strictEqual(putCalls[1].paramsHash, expected);
    assert.ok(!('maxEntries' in putCalls[0]), 'no cache cap asked for a dataset without params');
});

test('sent values reach the query as bound values and split the cache key', async () => {
    const us = await datasetCache.runDataset(APP, MODEL, PARAM, mgr, { params: { region: 'US' } });
    const eu = await datasetCache.runDataset(APP, MODEL, PARAM, mgr, { params: { region: 'EU', min: '50' } });
    const dflt = await datasetCache.runDataset(APP, MODEL, PARAM, mgr, {});
    assert.strictEqual(total(us), 23);
    assert.strictEqual(total(eu), 100);
    assert.strictEqual(total(dflt), 110, 'the default region, no min clause');
    assert.ok(dbCalls.every((c) => !c.sql.includes("'US'") && !c.sql.includes('EU')), 'values are never inlined into the SQL');
    assert.ok(dbCalls[0].params.includes('US'));
    const keys = new Set(putCalls.map((p) => p.paramsHash));
    assert.strictEqual(keys.size, 3);
    assert.ok(putCalls.every((p) => p.maxEntries > 0), 'a parameterised dataset caps its cache rows');

    // The same values again: a hit, no new query.
    const again = await datasetCache.runDataset(APP, MODEL, PARAM, mgr, { params: { region: 'US' } });
    assert.strictEqual(again.cached, true);
    assert.strictEqual(dbCalls.length, 3);
});

test('the row rules still apply on top of the parameter', async () => {
    const out = await datasetCache.runDataset(APP, MODEL, PARAM, alice, { params: { region: 'EU' } });
    assert.strictEqual(total(out), 10, 'alice reads only her own EU row, never bob\'s');
});

test('a value that does not fit the type is a client-safe 400', async () => {
    await assert.rejects(
        datasetCache.runDataset(APP, MODEL, PARAM, mgr, { params: { min: 'lots' } }),
        (e) => e.status === 400 && e.safe === true && e.message.includes('"min"'),
    );
    assert.strictEqual(dbCalls.length, 0);
});

test('an unset required clause answers no rows without a query', async () => {
    const out = await datasetCache.runDataset(APP, MODEL, REQUIRED, mgr, {});
    assert.deepStrictEqual(out, { columns: [], rows: [], truncated: false, cached: false });
    assert.strictEqual(dbCalls.length, 0);
    const set = await datasetCache.runDataset(APP, MODEL, REQUIRED, mgr, { params: { region: 'US' } });
    assert.strictEqual(total(set), 23);
});

test('read access is checked before any value', async () => {
    await assert.rejects(
        datasetCache.runDataset(APP, MODEL, PARAM, { id: 'x', role: 'stranger' }, { params: { min: 'lots' } }),
        (e) => e.status === 403,
    );
});
