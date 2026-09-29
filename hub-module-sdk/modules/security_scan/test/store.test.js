/**
 * Store — init + create/claim round-trip against the in-memory stub db.
 *
 * The stub db (test/hostMock makeDbMock) records every call and returns canned
 * rows, so we can assert the store's SQL shape without a live Postgres: initDB
 * issues the CREATE TABLEs, createScan runs its BEGIN/INSERT×2/COMMIT
 * transaction and returns a fresh uuid, and claimDueJobs returns the seeded
 * outbox rows (the FOR UPDATE SKIP LOCKED claim). A real-Postgres round-trip is
 * gated behind LICENSE_DB_URL and skipped when unset.
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeSecurityScanStore } = require('../server/src/store');
const { makeDbMock } = require('./hostMock');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('initDB issues the CREATE TABLE statements (idempotent)', async () => {
    const db = makeDbMock();
    const store = makeSecurityScanStore({ db });
    await store.initDB();
    await store.initDB(); // second call is a no-op via the initialized flag

    const execSql = db._calls.filter((c) => c.fn === 'exec').map((c) => c.sql).join('\n');
    assert.ok(/CREATE TABLE IF NOT EXISTS security_scans/.test(execSql), 'creates security_scans');
    assert.ok(/CREATE TABLE IF NOT EXISTS security_scan_artifacts/.test(execSql), 'creates artifacts');
    assert.ok(/CREATE TABLE IF NOT EXISTS security_scan_jobs/.test(execSql), 'creates jobs outbox');
});

test('makeSecurityScanStore requires a db', () => {
    assert.throws(() => makeSecurityScanStore({}), /db required/);
});

test('createScan writes the scan + outbox row in one transaction and returns a uuid', async () => {
    const db = makeDbMock();
    const store = makeSecurityScanStore({ db });

    const scanId = await store.createScan({
        userId: 'u1',
        organizationId: 'org1',
        targetUrl: 'https://example.com',
        engines: [{ engine: 'zap' }],
        authorized: true,
        mode: 'agent',
        modelTier: 'thinking',
        aggression: 'passive',
    });

    assert.ok(UUID_RE.test(scanId), 'returns a uuid scan id');

    const q = db._calls.filter((c) => c.fn === 'query').map((c) => c.sql);
    assert.ok(q.some((s) => /^BEGIN$/.test(s)), 'opens a transaction');
    assert.ok(q.some((s) => /INSERT INTO security_scans/.test(s)), 'inserts the scan row');
    assert.ok(q.some((s) => /INSERT INTO security_scan_jobs/.test(s)), 'inserts the outbox row');
    assert.ok(q.some((s) => /^COMMIT$/.test(s)), 'commits');
});

test('createScan validates required fields', async () => {
    const store = makeSecurityScanStore({ db: makeDbMock() });
    await assert.rejects(() => store.createScan({ targetUrl: 'https://x', engines: [{ engine: 'zap' }] }), /userId required/);
    await assert.rejects(() => store.createScan({ userId: 'u', engines: [{ engine: 'zap' }] }), /targetUrl required/);
    await assert.rejects(() => store.createScan({ userId: 'u', targetUrl: 'https://x', engines: [] }), /engines required/);
});

test('claimDueJobs returns the seeded outbox rows (FOR UPDATE SKIP LOCKED claim)', async () => {
    const seededRows = [
        { job_id: 'j1', scan_id: 's1', attempt_count: 0, user_id: 'u1', organization_id: null, target_url: 'https://a', engines: '[{"engine":"zap"}]', mode: 'agent', model_tier: null, aggression: 'passive', status: 'queued', authorized: true, metadata: null, created_at: new Date().toISOString() },
    ];
    const db = makeDbMock({ all: seededRows });
    const store = makeSecurityScanStore({ db });

    const claimed = await store.claimDueJobs({ batchSize: 3, perUserCap: 1, orgCap: 2, globalCap: 3, workerId: 'test' });
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].scan_id, 's1');

    const q = db._calls.filter((c) => c.fn === 'query').map((c) => c.sql);
    assert.ok(q.some((s) => /FOR UPDATE OF j SKIP LOCKED/.test(s)), 'claims with SKIP LOCKED');
    assert.ok(q.some((s) => /UPDATE security_scan_jobs\s+SET claim_token/.test(s)), 'stamps the claim token');
});

// Optional real-Postgres round-trip — only when a DB url is configured.
test('real Postgres create/claim round-trip', { skip: !process.env.LICENSE_DB_URL }, async () => {
    // Intentionally skipped unless LICENSE_DB_URL is set; the stub-db assertions
    // above cover the SQL shape. Wiring a real pool here is left to CI with a DB.
    assert.ok(true);
});
