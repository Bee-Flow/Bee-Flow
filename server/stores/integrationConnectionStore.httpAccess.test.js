/**
 * Unit tests for the Feature-C access helpers on integrationConnectionStore:
 * authorizeConnectionUse (own-or-grant gate for ONE connection id) and
 * listAccessibleConnections (own + lent union with `access` flags).
 *
 * db is mocked (same module-cache approach as integrationConnectionStore.test.js);
 * the SQL text + bound params are asserted, the JS decision flow is exercised.
 *
 * Run: node --test stores/integrationConnectionStore.httpAccess.test.js
 */

const assert = require('assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';
process.env.INTEGRATION_CONNECTIONS_BACKFILL = '0'; // no boot timer in tests

// ── Mock ../db before the store loads ───────────────────────────────
const mockState = {
    row: null,           // integration_connections row by id
    grant: null,         // grant row (or null)
    lastGrantSql: null,
    lastGrantParams: null,
    ownedRows: [],       // listConnectionsForUser rows
    lentRows: [],        // lent-union rows
    lastLentSql: null,
    lastLentParams: null,
};
const mockDb = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getAll: async (sql, params) => {
        if (sql.includes('connection_grants')) { mockState.lastLentSql = sql; mockState.lastLentParams = params; return mockState.lentRows; }
        if (sql.includes('owner_user_id = $1')) return mockState.ownedRows;
        return [];
    },
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    getOne: async (sql, params) => {
        if (sql.includes('connection_grants')) { mockState.lastGrantSql = sql; mockState.lastGrantParams = params; return mockState.grant; }
        if (sql.includes('WHERE id = $1')) return mockState.row;
        return null;
    },
};
const dbPath = require.resolve('../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = mockDb;
require.cache[dbPath].loaded = true;

const store = require('./integrationConnectionStore');

function httpRow(over = {}) {
    return {
        id: 'c1', owner_user_id: 'owner1', org_id: 'orgA', provider: 'http',
        label: 'Billing API', kind: 'bearer', status: 'active', is_default: true,
        secret: 'enc', secret_meta: {}, last_used_at: null, last_error: null,
        created_at: 't0', updated_at: 't1',
        ...over,
    };
}

let passed = 0;
function test(name, fn) { return fn().then(() => { passed++; console.log(`  ✓ ${name}`); }); }

console.log('integrationConnectionStore — http access helpers');

async function run() {
    // ── authorizeConnectionUse ──────────────────────────────────────
    await test('unknown id → not_found', async () => {
        mockState.row = null;
        const r = await store.authorizeConnectionUse({ connectionId: 'nope', runningUserId: 'u1', runningUserOrgId: 'orgA' });
        assert.deepStrictEqual(r, { ok: false, reason: 'not_found' });
    });

    await test('owner → ok, mode own, shaped connection with NO secret field', async () => {
        mockState.row = httpRow();
        const r = await store.authorizeConnectionUse({ connectionId: 'c1', runningUserId: 'owner1', runningUserOrgId: 'orgA' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.mode, 'own');
        assert.strictEqual(r.connection.id, 'c1');
        assert.strictEqual(r.connection.label, 'Billing API');
        assert.ok(!('secret' in r.connection), 'shapeConnection must not expose the secret blob');
    });

    await test('non-owner with a matching grant → delegated', async () => {
        mockState.row = httpRow();
        mockState.grant = { grant_id: 'g1' };
        const r = await store.authorizeConnectionUse({ connectionId: 'c1', runningUserId: 'u2', runningUserOrgId: 'orgA', runningUserGroups: ['grp1'] });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.mode, 'delegated');
    });

    await test('grant query binds connectionId + RUNNING user org (structural isolation) + groups', async () => {
        mockState.row = httpRow({ org_id: 'orgA' });
        mockState.grant = null;
        await store.authorizeConnectionUse({ connectionId: 'c1', runningUserId: 'u2', runningUserOrgId: 'orgB', runningUserGroups: ['g1', 'g2'] });
        // params: [connectionId, runnerOrg, runningUserId, groups]
        assert.strictEqual(mockState.lastGrantParams[0], 'c1');
        assert.strictEqual(mockState.lastGrantParams[1], 'orgB', 'org guard must be the RUNNER org, so an orgA grant can never match');
        assert.strictEqual(mockState.lastGrantParams[2], 'u2');
        assert.deepStrictEqual(mockState.lastGrantParams[3], ['g1', 'g2']);
    });

    await test('grant SQL filters revoked and expired grants', async () => {
        assert.ok(mockState.lastGrantSql.includes('revoked_at IS NULL'), 'revoked grants must never authorize');
        assert.ok(mockState.lastGrantSql.includes('expires_at IS NULL OR cg.expires_at > NOW()'), 'expired grants must never authorize');
        assert.ok(mockState.lastGrantSql.includes('cg.org_id = $2'), 'org isolation must be in the SQL, not app code');
    });

    await test('grant SQL matches UNSCOPED grants only (resource-scoped lends never authorize automations)', async () => {
        assert.ok(
            mockState.lastGrantSql.includes('cg.resource_type IS NULL AND cg.resource_id IS NULL'),
            'a lend scoped to e.g. one studio_app must not authorize free-standing http_request use',
        );
    });

    await test('non-owner without a grant → forbidden (no status leak)', async () => {
        mockState.row = httpRow({ status: 'needs_reauth' });
        mockState.grant = null;
        const r = await store.authorizeConnectionUse({ connectionId: 'c1', runningUserId: 'u9', runningUserOrgId: 'orgA' });
        assert.deepStrictEqual(r, { ok: false, reason: 'forbidden' });
    });

    await test('own but needs_reauth → surfaced as reason with shaped connection', async () => {
        mockState.row = httpRow({ status: 'needs_reauth' });
        const r = await store.authorizeConnectionUse({ connectionId: 'c1', runningUserId: 'owner1', runningUserOrgId: 'orgA' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'needs_reauth');
        assert.strictEqual(r.connection.label, 'Billing API');
        assert.ok(!('secret' in r.connection));
    });

    await test('granted but revoked-status connection → reason revoked', async () => {
        mockState.row = httpRow({ status: 'revoked' });
        mockState.grant = { grant_id: 'g1' };
        const r = await store.authorizeConnectionUse({ connectionId: 'c1', runningUserId: 'u2', runningUserOrgId: 'orgA' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'revoked');
    });

    // ── listAccessibleConnections ───────────────────────────────────
    await test('own + lent union with access flags', async () => {
        mockState.ownedRows = [httpRow({ id: 'mine1', owner_user_id: 'u1', label: 'Mine' })];
        mockState.lentRows = [httpRow({ id: 'lent1', owner_user_id: 'owner2', label: 'Shared' })];
        const list = await store.listAccessibleConnections({ userId: 'u1', orgId: 'orgA', groups: ['g1'], provider: 'http' });
        assert.strictEqual(list.length, 2);
        const mine = list.find(c => c.id === 'mine1');
        const lent = list.find(c => c.id === 'lent1');
        assert.strictEqual(mine.access, 'own');
        assert.strictEqual(lent.access, 'lent');
        assert.ok(list.every(c => !('secret' in c)), 'no secret blob in any listed connection');
    });

    await test('lent query binds the caller org + provider and excludes own rows', async () => {
        // params: [orgId, provider, userId, groups]
        assert.strictEqual(mockState.lastLentParams[0], 'orgA');
        assert.strictEqual(mockState.lastLentParams[1], 'http');
        assert.strictEqual(mockState.lastLentParams[2], 'u1');
        assert.deepStrictEqual(mockState.lastLentParams[3], ['g1']);
        assert.ok(mockState.lastLentSql.includes('ic.owner_user_id <> $3'), 'own rows come from the owned branch, never doubled via a self-grant');
        assert.ok(mockState.lastLentSql.includes('revoked_at IS NULL'));
        assert.ok(mockState.lastLentSql.includes('cg.org_id = $1'), 'org isolation structural in SQL');
        assert.ok(
            mockState.lastLentSql.includes('cg.resource_type IS NULL AND cg.resource_id IS NULL'),
            'picker must not advertise credentials whose lend is scoped to another resource',
        );
    });

    await test('empty org funnels through the sentinel', async () => {
        mockState.ownedRows = []; mockState.lentRows = [];
        await store.listAccessibleConnections({ userId: 'u1', orgId: '', provider: 'http' });
        assert.strictEqual(mockState.lastLentParams[0], store.DEFAULT_ORG_SENTINEL);
    });

    console.log(`\nintegrationConnectionStore.httpAccess: ${passed} passed\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
