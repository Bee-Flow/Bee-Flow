/**
 * App Studio v2 — datasetCache SECURITY + freshness test.
 *
 * Drives the REAL runDataset against the REAL queryCompiler + rlsGateway (only
 * the two stores are stubbed): a real in-memory better-sqlite3 engine executes
 * the compiled SQL, so RLS scoping is exercised end-to-end, and an in-memory
 * cache mirrors studio_app_dataset_cache's (dataset_id, viewer_scope_key,
 * params_hash, data_version, expiry) semantics.
 *
 * Asserts:
 *   • cache MISS then HIT (a repeat run doesn't touch the engine);
 *   • viewer_scope_key PARTITIONS manager vs member-A vs member-B — one
 *     member's cached rows are NEVER served for a different scope key;
 *   • a data_version bump invalidates the cache;
 *   • TTL expiry invalidates the cache;
 *   • the access filter is ALWAYS applied (a member folds only their rows);
 *   • ?refresh forces a recompute past a valid cache row.
 *
 * Run: cd server && node --test appStudio/datasetCache.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── In-memory engine (per-app `tasks` table) ────────────────────────
const memdb = new Database(':memory:');
memdb.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, created_by TEXT, org_id TEXT,
    title TEXT, region TEXT, amount INTEGER
)`);
function norm(params) { return (params || []).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)); }

const dbCalls = [];
stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params = []) => {
        dbCalls.push({ ownerId, appId, sql, params });
        const rows = memdb.prepare(sql).all(...norm(params));
        return { rows, columns: [], truncated: false };
    },
});

// ── In-memory metadata store stub (roles + data_version + cache) ────
const membership = new Map();          // `${appId}:${userId}` → roleKey
let dataVersions = {};                  // tableKey → version (mutable per test)
const cacheRows = new Map();            // `${dsId}|${scope}|${params}` → {dataVersion,result,expiresAt}
const putCalls = [];

stub('../stores/studioAppDataStore', {
    getMemberRole: async (appId, userId) => membership.get(`${appId}:${userId}`) || null,
    getDataModel: async () => ({ dataVersions }),
    getCache: async (datasetId, viewerScopeKey, paramsHash, dataVersion) => {
        const row = cacheRows.get(`${datasetId}|${viewerScopeKey}|${paramsHash}`);
        if (!row) return null;
        if (row.dataVersion !== (parseInt(dataVersion, 10) || 0)) return null;   // stale version → miss
        if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null; // expired → miss
        return { result: row.result, dataVersion: row.dataVersion, viewerScopeKey, paramsHash };
    },
    putCache: async (datasetId, { viewerScopeKey, paramsHash, dataVersion, result, rowCount, ttlSeconds }) => {
        putCalls.push({ datasetId, viewerScopeKey, paramsHash, dataVersion, rowCount });
        const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : 60;
        cacheRows.set(`${datasetId}|${viewerScopeKey}|${paramsHash}`, {
            dataVersion: parseInt(dataVersion, 10) || 0,
            result,
            expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        });
        return { ok: true };
    },
});

const datasetCache = require('./datasetCache');
const rlsGateway = require('./rlsGateway');

// ── Fixtures ────────────────────────────────────────────────────────
const APP = { id: 'app-1', userId: 'owner-1', organizationId: 'org1' };
const MODEL = {
    modelVersion: 1,
    roles: [{ key: 'manager' }, { key: 'member' }],
    roleMapping: { default: null, byGroup: {} },
    tables: [{
        id: 'tbl_tasks0', key: 'tasks', name: 'Tasks',
        fields: [
            { id: 'fld_title', key: 'title', type: 'text' },
            { id: 'fld_region', key: 'region', type: 'text' },
            { id: 'fld_amount', key: 'amount', type: 'number', subtype: 'integer' },
        ],
        access: {
            default: 'none',
            roles: {
                manager: { read: 'all' },
                member: { read: 'own' },
            },
            rowFilters: {},
        },
    }],
};
// A saved dataset: SUM(amount) AS total, no groupBy.
const DATASET = {
    id: 'ds-1', tableId: 'tbl_tasks0',
    descriptor: { aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] },
    cacheTtlSeconds: 60,
};

function seed({ id, by, amount }) {
    memdb.prepare(`INSERT INTO tasks (id, created_at, updated_at, created_by, org_id, title, region, amount)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', by, 'org1', 'T', 'EU', amount);
}

// viewer WITHOUT a role → runDataset resolves it via getMemberRole (real path).
function viewer(userId) { return { id: userId, organizationId: 'org1' }; }

test.beforeEach(() => {
    dbCalls.length = 0; putCalls.length = 0;
    cacheRows.clear();
    membership.clear();
    dataVersions = { tasks: 1 };
    memdb.exec('DELETE FROM tasks');
    membership.set('app-1:alice', 'member');
    membership.set('app-1:bob', 'member');
    membership.set('app-1:mgr', 'manager');
    seed({ id: 'rec_a1', by: 'alice', amount: 10 });
    seed({ id: 'rec_a2', by: 'alice', amount: 20 });
    seed({ id: 'rec_b1', by: 'bob', amount: 100 });
    seed({ id: 'rec_b2', by: 'bob', amount: 3 });
});

// ── computeViewerScopeKey partitioning (unit) ───────────────────────

test('computeViewerScopeKey partitions manager vs member-A vs member-B', () => {
    const table = MODEL.tables[0];
    const mgr = rlsGateway.compileAccessFilter(table, 'manager', { id: 'mgr' }, 'read');
    const a = rlsGateway.compileAccessFilter(table, 'member', { id: 'alice' }, 'read');
    const b = rlsGateway.compileAccessFilter(table, 'member', { id: 'bob' }, 'read');

    const kMgr = datasetCache.computeViewerScopeKey('manager', mgr);
    const kA = datasetCache.computeViewerScopeKey('member', a);
    const kB = datasetCache.computeViewerScopeKey('member', b);

    assert.notStrictEqual(kMgr, kA, 'manager and member must not share a scope key');
    assert.notStrictEqual(kA, kB, 'two members must not share a scope key');
    assert.notStrictEqual(kMgr, kB);
    // Deterministic: recomputing the same identity yields the same key.
    assert.strictEqual(kA, datasetCache.computeViewerScopeKey('member', rlsGateway.compileAccessFilter(table, 'member', { id: 'alice' }, 'read')));
});

// ── Cache miss → hit ────────────────────────────────────────────────

test('cache MISS then HIT: a repeated run is served from cache, no engine call', async () => {
    const first = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(first.cached, false, 'first run is a miss');
    assert.strictEqual(first.rows[0].total, 30, 'alice folds only her own 10+20');
    assert.strictEqual(dbCalls.length, 1, 'engine hit once on the miss');
    assert.strictEqual(putCalls.length, 1, 'result was memoised');

    const second = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(second.cached, true, 'second run is a hit');
    assert.strictEqual(second.rows[0].total, 30);
    assert.strictEqual(dbCalls.length, 1, 'no second engine call — served from cache');
});

// ── Scope partitioning: one member's cache is NEVER served to another ──

test('a member cache row is NEVER returned for a different viewer_scope_key', async () => {
    // Alice runs → caches under K_alice.
    const alice = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(alice.cached, false);
    assert.strictEqual(alice.rows[0].total, 30);
    assert.strictEqual(dbCalls.length, 1);

    // Bob runs the SAME dataset → different scope key → MISS (recompute), and
    // he sees HIS 100+3, never alice's cached 30.
    const bob = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('bob'));
    assert.strictEqual(bob.cached, false, 'bob does not read alice\'s cache row');
    assert.strictEqual(bob.rows[0].total, 103, 'bob folds only bob 100+3');
    assert.strictEqual(dbCalls.length, 2, 'bob forced his own engine computation');

    // Manager runs → sees EVERYONE (30+103 = 133), from a third partition.
    const mgr = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('mgr'));
    assert.strictEqual(mgr.cached, false);
    assert.strictEqual(mgr.rows[0].total, 133, 'manager folds all rows');

    // Three distinct partitions cached.
    assert.strictEqual(cacheRows.size, 3);
    const scopeKeys = [...putCalls.map((p) => p.viewerScopeKey)];
    assert.strictEqual(new Set(scopeKeys).size, 3, 'three distinct scope keys');

    // Alice again → still her own 30 from cache (never bob's / manager's).
    const alice2 = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(alice2.cached, true);
    assert.strictEqual(alice2.rows[0].total, 30);
});

// ── data_version invalidation ───────────────────────────────────────

test('a data_version bump invalidates the cache (forces recompute)', async () => {
    const first = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(first.cached, false);
    const hit = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(hit.cached, true);

    // A write bumped the table's data_version — the old cache row (v1) no
    // longer matches, so the next run recomputes.
    dataVersions.tasks = 2;
    seed({ id: 'rec_a3', by: 'alice', amount: 5 });
    const afterBump = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(afterBump.cached, false, 'stale-version cache is not served');
    assert.strictEqual(afterBump.rows[0].total, 35, 'recomputed with the new row');
});

// ── TTL expiry ──────────────────────────────────────────────────────

test('an expired cache row is not served (TTL)', async () => {
    const first = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(first.cached, false);

    // Force the stored row to have expired.
    for (const row of cacheRows.values()) row.expiresAt = new Date(Date.now() - 1000).toISOString();

    const afterExpiry = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(afterExpiry.cached, false, 'expired row → miss → recompute');
    assert.strictEqual(dbCalls.length, 2);
});

// ── ?refresh forces recompute ───────────────────────────────────────

test('refresh:true forces a recompute past a valid cache row', async () => {
    await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    const hit = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    assert.strictEqual(hit.cached, true);

    const forced = await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'), { refresh: true });
    assert.strictEqual(forced.cached, false, 'refresh bypasses the cache');
    assert.strictEqual(forced.rows[0].total, 30);
});

// ── access filter is ALWAYS applied ─────────────────────────────────

test('the access filter is always applied (member SQL is created_by-scoped)', async () => {
    await datasetCache.runDataset(APP, MODEL, DATASET, viewer('alice'));
    const call = dbCalls.at(-1);
    assert.match(call.sql, /created_by/, 'compiled SQL carries the own-scope predicate');
    assert.ok(call.params.includes('alice'), 'the viewer id is bound as an access param');
    assert.strictEqual(call.ownerId, 'owner-1', 'engine runs acts-as-owner, never as the viewer');
});

// ── explicit role short-circuits resolution ─────────────────────────

test('a caller-provided role skips resolveViewerRole and still scopes rows', async () => {
    // No membership entry for "ghost" — but the route already resolved 'member'.
    const out = await datasetCache.runDataset(APP, MODEL, DATASET, { id: 'ghost', role: 'member' });
    assert.strictEqual(out.cached, false);
    // ghost owns no rows → own-scope folds to an empty sum (NULL → null/0).
    assert.ok(out.rows[0].total == null || out.rows[0].total === 0, 'own-scope with no rows folds empty');
    const call = dbCalls.at(-1);
    assert.ok(call.params.includes('ghost'), 'bound the provided viewer id, no membership lookup');
});

// ── inline descriptor (no id) runs live, never cached ───────────────

test('an inline descriptor (no dataset id) runs live and is never cached', async () => {
    const inline = { tableId: 'tbl_tasks0', descriptor: { aggregates: [{ fn: 'count', as: 'n' }] } };
    const out = await datasetCache.runDataset(APP, MODEL, inline, viewer('bob'));
    assert.strictEqual(out.cached, false);
    assert.strictEqual(out.rows[0].n, 2, 'bob has 2 rows');
    assert.strictEqual(putCalls.length, 0, 'inline queries are never memoised (no dataset FK)');
});

// ── groupBy through a relation (relatedField) ───────────────────────
// The related table is read under the viewer's own predicate on it; the saved
// dataset partitions by that predicate and is invalidated by a write to it.

memdb.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, created_by TEXT, org_id TEXT, name TEXT, segment TEXT)`);
memdb.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, created_by TEXT, org_id TEXT, amount INTEGER, customer TEXT)`);
memdb.prepare('INSERT INTO customers (id, created_by, name, segment) VALUES (?, ?, ?, ?), (?, ?, ?, ?)').run('cus_a', 'u9', 'Alpha', 'retail', 'cus_b', 'u9', 'Bravo', 'wholesale');
for (const [id, by, amount, customer] of [['o1', 'alice', 10, 'cus_a'], ['o2', 'alice', 20, 'cus_b'], ['o3', 'alice', 5, 'cus_a'], ['o4', 'bob', 99, 'cus_a']]) {
    memdb.prepare('INSERT INTO orders (id, created_by, amount, customer) VALUES (?, ?, ?, ?)').run(id, by, amount, customer);
}
const REL_MODEL = {
    roles: [{ key: 'member' }],
    tables: [
        {
            id: 'tbl_ord01', key: 'orders',
            fields: [{ id: 'f3', key: 'amount', type: 'number' }, { id: 'f4', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01' } }],
            access: { default: 'none', roles: { member: { read: 'own' } } },
        },
        {
            id: 'tbl_cust01', key: 'customers',
            fields: [{ id: 'f1', key: 'name', type: 'text' }, { id: 'f2', key: 'segment', type: 'text' }],
            access: { default: 'none', roles: { member: { read: 'all' } }, rowFilters: { member: 'record.segment == viewer.segment' } },
        },
    ],
};
const BY_NAME = { groupBy: [{ field: 'customer', relatedField: 'name', as: 'who' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }], orderBy: [{ field: 'total', dir: 'desc' }] };

test('the read runner groups through a relation under the related table\'s row rules', async () => {
    const dataReadRunner = require('./dataReadRunner');
    const ctxFor = (role, v) => ({ model: REL_MODEL, role, viewer: v, app: APP, ownerScope: 'owner-1' });
    const orders = REL_MODEL.tables[0];
    const retail = await dataReadRunner.runInlineAggregate(ctxFor('member', { id: 'alice', segment: 'retail' }), orders, BY_NAME);
    // alice's own orders; Bravo is wholesale, so its order lands in the empty group, never by name.
    assert.deepStrictEqual(retail.rows, [{ who: null, total: 20 }, { who: 'Alpha', total: 15 }]);
    const owner = await dataReadRunner.runInlineAggregate(ctxFor('owner', { id: 'owner-1' }), orders, { ...BY_NAME, groupFilter: [{ field: 'total', op: 'gt', value: 50 }] });
    assert.deepStrictEqual(owner.rows, [{ who: 'Alpha', total: 114 }]);
});

test('a saved dataset through a relation partitions by the related predicate and its version', async () => {
    const dataset = { id: 'ds-rel', tableId: 'tbl_ord01', descriptor: BY_NAME };
    const plain = { id: 'ds-plain', tableId: 'tbl_ord01', descriptor: { groupBy: [{ field: 'customer' }], aggregates: [{ fn: 'count', as: 'n' }] } };
    dataVersions = { orders: 3, customers: 4 };
    await datasetCache.runDataset(APP, REL_MODEL, dataset, { id: 'alice', role: 'member', segment: 'retail' });
    await datasetCache.runDataset(APP, REL_MODEL, dataset, { id: 'alice', role: 'member', segment: 'wholesale' });
    await datasetCache.runDataset(APP, REL_MODEL, plain, { id: 'alice', role: 'member', segment: 'retail' });
    const [retail, wholesale, flat] = putCalls;
    assert.notStrictEqual(retail.viewerScopeKey, wholesale.viewerScopeKey, 'another related predicate is another partition');
    assert.strictEqual(retail.dataVersion, 7, 'a write to either table moves the version');
    assert.strictEqual(flat.viewerScopeKey, datasetCache.computeViewerScopeKey('member', { where: '"created_by" = ?', params: ['alice'] }), 'without a relation: the key it always had');
    assert.strictEqual(flat.dataVersion, 3, 'without a relation: the version of the table alone');
});
