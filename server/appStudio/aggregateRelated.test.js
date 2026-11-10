/**
 * Grouping through a relation on the App Studio read paths:
 *   - relatedForAggregate hands the compiler the related table with the
 *     VIEWER's access predicate on it (1=0 for a role that may not read it),
 *     follows only relation fields to tables of this app with their own
 *     storage, and returns nothing for a descriptor without relatedField;
 *   - the shared read runner (POST /data/query, /data/batch) groups through a
 *     relation under the related table's row rules;
 *   - the saved-dataset cache partitions by the related predicate and is
 *     invalidated by a write to the related table, while a dataset without a
 *     relation keeps the key and data version it always had.
 *
 * Run: cd server && node --test appStudio/aggregateRelated.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const memdb = new Database(':memory:');
const sys = 'id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, created_by TEXT, org_id TEXT';
memdb.exec(`CREATE TABLE customers (${sys}, name TEXT, segment TEXT)`);
memdb.exec(`CREATE TABLE orders (${sys}, amount INTEGER, customer TEXT)`);
const insC = memdb.prepare('INSERT INTO customers (id, created_by, name, segment) VALUES (?, ?, ?, ?)');
insC.run('cus_a', 'u9', 'Alpha', 'retail');
insC.run('cus_b', 'u9', 'Bravo', 'wholesale');
const insO = memdb.prepare('INSERT INTO orders (id, created_by, amount, customer) VALUES (?, ?, ?, ?)');
[['o1', 'u1', 10, 'cus_a'], ['o2', 'u1', 20, 'cus_b'], ['o3', 'u1', 5, 'cus_a'], ['o4', 'u2', 99, 'cus_a']].forEach((r) => insO.run(...r));

const queries = [];
let dataVersions = {};
const cachePuts = [];
stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params = []) => {
        queries.push({ sql, params });
        return { rows: memdb.prepare(sql).all(...params), columns: [], truncated: false };
    },
});
stub('../stores/studioAppDataStore', {
    getDataModel: async () => ({ dataVersions }),
    getCache: async () => null,
    putCache: async (datasetId, entry) => { cachePuts.push(entry); },
    getDataset: async () => null,
});

const { relatedForAggregate } = require('./aggregateRelated.mts');
const dataReadRunner = require('./dataReadRunner');
const datasetCache = require('./datasetCache');

const ROLES = { member: { read: 'all', create: false, update: 'none', delete: 'none' } };
const CUSTOMERS = {
    id: 'tbl_cust01', key: 'customers',
    fields: [{ id: 'f1', key: 'name', type: 'text' }, { id: 'f2', key: 'segment', type: 'text' }],
    access: { default: 'none', roles: ROLES, rowFilters: { member: 'record.segment == viewer.segment' } },
};
const ORDERS = {
    id: 'tbl_ord01', key: 'orders',
    fields: [{ id: 'f3', key: 'amount', type: 'number' }, { id: 'f4', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01' } }],
    access: { default: 'none', roles: { member: { read: 'own', create: false, update: 'none', delete: 'none' }, outsider: { read: 'own', create: false, update: 'none', delete: 'none' } } },
};
const MODEL = { tables: [ORDERS, CUSTOMERS] };
const BY_NAME = { groupBy: [{ field: 'customer', relatedField: 'name', as: 'who' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }], orderBy: [{ field: 'total', dir: 'desc' }] };

test('relatedForAggregate: the viewer\'s predicate on the related table, only when the descriptor goes through a relation', () => {
    assert.strictEqual(relatedForAggregate(MODEL, ORDERS, [{ field: 'customer' }], { role: 'member', viewer: { id: 'u1' } }), undefined);
    assert.strictEqual(relatedForAggregate(MODEL, ORDERS, undefined, { role: 'member', viewer: { id: 'u1' } }), undefined);
    const member = relatedForAggregate(MODEL, ORDERS, BY_NAME.groupBy, { role: 'member', viewer: { id: 'u1', segment: 'retail' } });
    assert.deepStrictEqual(Object.keys(member), ['customer']);
    assert.strictEqual(member.customer.tableMeta, CUSTOMERS);
    assert.deepStrictEqual(member.customer.accessFilter.params, ['retail']);
    const outsider = relatedForAggregate(MODEL, ORDERS, BY_NAME.groupBy, { role: 'outsider', viewer: { id: 'u1' } });
    assert.deepStrictEqual(outsider.customer.accessFilter, { where: '1=0', params: [] });
    // Not a relation, or a target outside the app's own storage: not handed over (the compiler then refuses).
    assert.strictEqual(relatedForAggregate(MODEL, ORDERS, [{ field: 'amount', relatedField: 'x' }], { role: 'owner', viewer: {} }), undefined);
    const linked = { tables: [ORDERS, { ...CUSTOMERS, source: { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' } }] };
    assert.strictEqual(relatedForAggregate(linked, ORDERS, BY_NAME.groupBy, { role: 'owner', viewer: {} }), undefined);
});

const ctxFor = (role, viewer) => ({ model: MODEL, role, viewer, app: { id: 'app_1', userId: 'owner_1' }, ownerScope: 'owner_1' });

test('the read runner groups through a relation under the related table\'s row rules', async () => {
    const retail = await dataReadRunner.runInlineAggregate(ctxFor('member', { id: 'u1', segment: 'retail' }), ORDERS, BY_NAME);
    // u1's own orders only; Bravo is wholesale, so its order lands in the empty group, by name never.
    assert.deepStrictEqual(retail.rows, [{ who: null, total: 20 }, { who: 'Alpha', total: 15 }]);
    const owner = await dataReadRunner.runInlineAggregate(ctxFor('owner', { id: 'owner_1' }), ORDERS, BY_NAME);
    assert.deepStrictEqual(owner.rows, [{ who: 'Alpha', total: 114 }, { who: 'Bravo', total: 20 }]);
    const filtered = await dataReadRunner.runInlineAggregate(ctxFor('owner', { id: 'owner_1' }), ORDERS, { ...BY_NAME, groupFilter: [{ field: 'total', op: 'gt', value: 50 }] });
    assert.deepStrictEqual(filtered.rows, [{ who: 'Alpha', total: 114 }]);
});

test('a saved dataset through a relation partitions its cache by the related predicate and its version', async () => {
    const app = { id: 'app_1', userId: 'owner_1' };
    const dataset = { id: 'ds_1', tableId: 'tbl_ord01', descriptor: BY_NAME };
    const plainDataset = { id: 'ds_2', tableId: 'tbl_ord01', descriptor: { groupBy: [{ field: 'customer' }], aggregates: [{ fn: 'count', as: 'n' }] } };
    dataVersions = { orders: 3, customers: 4 };
    cachePuts.length = 0;
    await datasetCache.runDataset(app, MODEL, dataset, { id: 'u1', role: 'member', segment: 'retail' });
    await datasetCache.runDataset(app, MODEL, dataset, { id: 'u1', role: 'member', segment: 'wholesale' });
    await datasetCache.runDataset(app, MODEL, plainDataset, { id: 'u1', role: 'member', segment: 'retail' });
    const [retail, wholesale, plain] = cachePuts;
    assert.notStrictEqual(retail.viewerScopeKey, wholesale.viewerScopeKey, 'another related predicate is another partition');
    assert.strictEqual(retail.dataVersion, 7, 'a write to either table moves the version');
    const mainAccess = { where: '"created_by" = ?', params: ['u1'] };
    assert.strictEqual(plain.viewerScopeKey, datasetCache.computeViewerScopeKey('member', mainAccess), 'without a relation: the key it always had');
    assert.strictEqual(plain.dataVersion, 3, 'without a relation: the version of the table alone');
});
