/**
 * Unit tests for orgHealthStore — db mocked via require-cache injection (the
 * integrationConnectionStore.test.js pattern); the SQL itself is not executed,
 * the JS control flow, parameter wiring, cursor keyset logic and the pure
 * computeHealth classifier are.
 *
 * Run: cd server && node --test stores/orgHealthStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ── Mock ../db BEFORE the store loads ──────────────────────────────────────
const calls = { exec: [], run: [], getAll: [] };
let runImpl = async () => ({ rows: [], rowCount: 0 });
let getAllImpl = async () => [];

const mockDb = {
    exec: async (sql) => { calls.exec.push(sql); return {}; },
    run: async (sql, params) => { calls.run.push({ sql, params }); return runImpl(sql, params); },
    getOne: async () => null,
    getAll: async (sql, params) => { calls.getAll.push({ sql, params }); return getAllImpl(sql, params); },
};
const dbPath = require.resolve('../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = mockDb;
require.cache[dbPath].loaded = true;

const store = require('./orgHealthStore');

test.beforeEach(() => {
    calls.run.length = 0;
    calls.getAll.length = 0;
    runImpl = async () => ({ rows: [], rowCount: 0 });
    getAllImpl = async () => [];
});

// ── initDB ─────────────────────────────────────────────────────────────────

test('initDB is memoized (single exec batch with all three tables)', async () => {
    await store.initDB();
    const n = calls.exec.length;
    assert.ok(n >= 1);
    const ddl = calls.exec.join('\n');
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS org_health_problems/);
    assert.match(ddl, /UNIQUE \(subject_key, code\)/);
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS org_health_events/);
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS org_health_liveness/);
    await store.initDB();
    await store.initDB();
    assert.strictEqual(calls.exec.length, n, 'repeated initDB() must not re-run DDL');
});

// ── cursor helpers ─────────────────────────────────────────────────────────

test('cursor encode/decode roundtrip', () => {
    const row = { created_at: new Date('2026-07-23T10:00:00Z'), id: '0b7e8f7a-1111-2222-3333-444455556666' };
    const cur = store._encodeCursor(row);
    const dec = store._decodeCursor(cur);
    assert.deepStrictEqual(dec, { t: '2026-07-23T10:00:00.000Z', id: row.id });
});

test('cursor decode rejects malformed input', () => {
    assert.strictEqual(store._decodeCursor(null), null);
    assert.strictEqual(store._decodeCursor(''), null);
    assert.strictEqual(store._decodeCursor('not-base64-json!!'), null);
    assert.strictEqual(store._decodeCursor(Buffer.from('{"x":1}').toString('base64')), null);
});

// ── upsertProblem ──────────────────────────────────────────────────────────

test('upsertProblem: fresh insert → {inserted:true, reopened:false}', async () => {
    runImpl = async () => ({ rows: [{ inserted: true, count: 1, prev_resolved_at: null }], rowCount: 1 });
    const r = await store.upsertProblem({
        subjectKey: 'org1', organizationId: 'org1',
        code: 'chat.subscription_blocked', category: 'chat', severity: 'critical',
        source: 'limits', message: 'blocked', remediation: 'fix it', meta: { reason: 'no_subscription' },
    });
    assert.deepStrictEqual(r, { inserted: true, reopened: false, count: 1 });
    const call = calls.run[calls.run.length - 1];
    assert.match(call.sql, /ON CONFLICT \(subject_key, code\) DO UPDATE/);
    assert.match(call.sql, /\(xmax = 0\) AS inserted/);
    assert.match(call.sql, /WITH prev AS/);
    assert.strictEqual(call.params[0], 'org1');
    assert.strictEqual(call.params[2], 'chat.subscription_blocked');
    assert.strictEqual(call.params[8], JSON.stringify({ reason: 'no_subscription' }));
});

test('upsertProblem: recurrence → {inserted:false, reopened:false}, count bumped', async () => {
    runImpl = async () => ({ rows: [{ inserted: false, count: 42, prev_resolved_at: null }], rowCount: 1 });
    const r = await store.upsertProblem({
        subjectKey: 'org1', code: 'auth.blocked_onboarding_pending', category: 'auth', severity: 'warning',
    });
    assert.deepStrictEqual(r, { inserted: false, reopened: false, count: 42 });
});

test('upsertProblem: previously-resolved row → reopened:true', async () => {
    runImpl = async () => ({ rows: [{ inserted: false, count: 5, prev_resolved_at: new Date('2026-07-01T00:00:00Z') }], rowCount: 1 });
    const r = await store.upsertProblem({
        subjectKey: 'nc:abc', code: 'bootstrap.verify_failed', category: 'bootstrap', severity: 'error',
    });
    assert.strictEqual(r.inserted, false);
    assert.strictEqual(r.reopened, true);
});

test('upsertProblem: invalid severity coerced, missing essentials → null', async () => {
    runImpl = async (sql, params) => {
        assert.strictEqual(params[4], 'warning', 'bad severity must coerce to warning');
        return { rows: [{ inserted: true, count: 1, prev_resolved_at: null }], rowCount: 1 };
    };
    await store.upsertProblem({ subjectKey: 's', code: 'c', category: 'auth', severity: 'apocalyptic' });
    assert.strictEqual(await store.upsertProblem({ code: 'x', category: 'auth' }), null);
    assert.strictEqual(await store.upsertProblem({ subjectKey: 's', category: 'auth' }), null);
});

// ── resolveProblems ────────────────────────────────────────────────────────

test('resolveProblems returns rowCount and targets only open rows', async () => {
    runImpl = async () => ({ rows: [], rowCount: 3 });
    const n = await store.resolveProblems('org1', ['chat.subscription_blocked', 'chat.provider_error'], 'system');
    assert.strictEqual(n, 3);
    const call = calls.run[calls.run.length - 1];
    assert.match(call.sql, /resolved_at IS NULL/);
    assert.match(call.sql, /code = ANY\(\$2::text\[\]\)/);
    assert.match(call.sql, /\(organization_id = \$1 OR subject_key = \$1\)/);
    assert.deepStrictEqual(call.params[1], ['chat.subscription_blocked', 'chat.provider_error']);
});

test('resolveProblems: empty codes or missing subject → 0 without a query', async () => {
    assert.strictEqual(await store.resolveProblems('org1', []), 0);
    assert.strictEqual(await store.resolveProblems(null, ['x']), 0);
    assert.strictEqual(calls.run.length, 0);
});

// ── appendEvent ────────────────────────────────────────────────────────────

test('appendEvent inserts with coerced actor kind and severity', async () => {
    runImpl = async () => ({ rows: [{ id: 'ev1', created_at: new Date() }], rowCount: 1 });
    const r = await store.appendEvent({
        subjectKey: 'org1', organizationId: 'org1', code: 'bootstrap.org_created',
        category: 'bootstrap', severity: 'nonsense', actorKind: 'hacker',
        message: 'created', meta: { a: 1 }, ip: '1.2.3.4',
    });
    assert.strictEqual(r.id, 'ev1');
    const call = calls.run[calls.run.length - 1];
    assert.strictEqual(call.params[4], 'info', 'invalid severity → info');
    assert.strictEqual(call.params[5], 'system', 'invalid actorKind → system');
    assert.strictEqual(call.params[8], JSON.stringify({ a: 1 }));
});

// ── listProblems / listEvents ──────────────────────────────────────────────

test('listProblems maps rows to the pinned camelCase shape', async () => {
    const d1 = new Date('2026-07-01T00:00:00Z');
    const d2 = new Date('2026-07-20T00:00:00Z');
    getAllImpl = async () => [{
        id: 7, subject_key: 'org1', organization_id: 'org1',
        code: 'chat.subscription_blocked', category: 'chat', severity: 'critical',
        source: 'limits', message: 'm', remediation: 'r', meta: { reason: 'no_subscription' },
        count: 4, first_seen_at: d1, last_seen_at: d2, resolved_at: null, resolved_by: null,
    }];
    const rows = await store.listProblems({ organizationId: 'org1' });
    assert.strictEqual(rows.length, 1);
    const p = rows[0];
    assert.strictEqual(p.code, 'chat.subscription_blocked');
    assert.strictEqual(p.severity, 'critical');
    assert.strictEqual(p.count, 4);
    assert.strictEqual(p.firstSeenAt, d1);
    assert.strictEqual(p.lastSeenAt, d2);
    assert.strictEqual(p.resolvedAt, null);
    assert.deepStrictEqual(p.meta, { reason: 'no_subscription' });
    const q = calls.getAll[calls.getAll.length - 1];
    assert.match(q.sql, /resolved_at IS NULL/, 'default excludes resolved rows');
});

test('listProblems can narrow to one code (the backstop backoff read)', async () => {
    await store.listProblems({ code: 'connector.nc_sync_failed', limit: 500 });
    const q = calls.getAll[calls.getAll.length - 1];
    assert.match(q.sql, /code = \$1/);
    assert.match(q.sql, /resolved_at IS NULL/);
    assert.deepStrictEqual(q.params, ['connector.nc_sync_failed', 500]);
});

test('listEvents: keyset pagination returns nextCursor and trims to limit', async () => {
    const mkRow = (i) => ({
        id: `00000000-0000-0000-0000-00000000000${i}`,
        subject_key: 'org1', organization_id: 'org1', code: 'health.resolved',
        category: 'health', severity: 'info', actor_kind: 'system', actor_user_id: null,
        message: null, meta: {}, ip: null,
        created_at: new Date(`2026-07-2${i}T00:00:00Z`),
    });
    getAllImpl = async () => [mkRow(3), mkRow(2), mkRow(1)]; // limit+1 rows
    const { events, nextCursor } = await store.listEvents({ organizationId: 'org1', limit: 2 });
    assert.strictEqual(events.length, 2);
    assert.ok(nextCursor, 'must signal another page');
    const dec = store._decodeCursor(nextCursor);
    assert.strictEqual(dec.id, '00000000-0000-0000-0000-000000000002', 'cursor points at last returned row');
    assert.strictEqual(events[0].createdAt.toISOString(), '2026-07-23T00:00:00.000Z');
    assert.strictEqual(events[0].actorKind, 'system');
});

test('listEvents: cursor + filters land in SQL and params', async () => {
    getAllImpl = async () => [];
    const cursor = store._encodeCursor({ created_at: new Date('2026-07-22T00:00:00Z'), id: '00000000-0000-0000-0000-000000000009' });
    const { events, nextCursor } = await store.listEvents({
        organizationId: 'org1', code: 'chat.dlp_blocked', severity: 'info',
        since: '2026-07-01', limit: 10, cursor,
    });
    assert.deepStrictEqual(events, []);
    assert.strictEqual(nextCursor, null);
    const q = calls.getAll[calls.getAll.length - 1];
    assert.match(q.sql, /\(created_at, id\) < \(\$\d+::timestamptz, \$\d+::uuid\)/);
    assert.match(q.sql, /ORDER BY created_at DESC, id DESC/);
    assert.ok(q.params.includes('chat.dlp_blocked'));
    assert.ok(q.params.includes('info'));
    assert.ok(q.params.includes('2026-07-22T00:00:00.000Z'));
    assert.ok(q.params.includes('00000000-0000-0000-0000-000000000009'));
    assert.strictEqual(q.params[q.params.length - 1], 11, 'fetches limit+1 rows');
});

// ── touchLiveness ──────────────────────────────────────────────────────────

test('touchLiveness upserts the right column flags', async () => {
    await store.touchLiveness('org1', { statusReport: true, connectorVersion: '1.2.3' });
    const call = calls.run[calls.run.length - 1];
    assert.match(call.sql, /ON CONFLICT \(organization_id\) DO UPDATE/);
    assert.deepStrictEqual(call.params, ['org1', false, false, true, '1.2.3']);
});

test('touchLiveness without orgId is a no-op', async () => {
    await store.touchLiveness(null, { authOk: true });
    assert.strictEqual(calls.run.length, 0);
});

// ── computeHealth (pure classifier, pinned enum + priority) ────────────────

const healthyBase = {
    hasActiveSubscription: true,
    ncInstanceId: 'inst1',
    ncOnboardingCompletedAt: new Date('2026-07-01'),
    users: { total: 5, active: 4, pending: 1 },
    messagesTotal: 10,
    messages30d: 3,
    problems: [],
};

test('computeHealth: tenant_key_mismatch outranks everything', () => {
    const h = store.computeHealth({
        ...healthyBase,
        hasActiveSubscription: false, // would be no_subscription otherwise
        problems: [{ code: 'auth.no_matching_tenant_key', category: 'auth', severity: 'critical' }],
    });
    assert.strictEqual(h, 'tenant_key_mismatch');
    assert.strictEqual(store.computeHealth({
        ...healthyBase,
        problems: [{ code: 'connector.key_divergence', category: 'connector', severity: 'critical' }],
    }), 'tenant_key_mismatch');
});

test('computeHealth: no_subscription from authoritative flag or fallback codes', () => {
    assert.strictEqual(store.computeHealth({ ...healthyBase, hasActiveSubscription: false }), 'no_subscription');
    // flag unknown → open subscription-block problem decides
    assert.strictEqual(store.computeHealth({
        ...healthyBase, hasActiveSubscription: undefined,
        problems: [{ code: 'chat.subscription_blocked', category: 'chat', severity: 'critical' }],
    }), 'no_subscription');
    assert.strictEqual(store.computeHealth({
        ...healthyBase, hasActiveSubscription: null,
        problems: [{ code: 'bootstrap.community_fallback', category: 'bootstrap', severity: 'critical' }],
    }), 'no_subscription');
});

test('computeHealth: onboarding_pending when NC-bound and wizard not completed', () => {
    assert.strictEqual(store.computeHealth({ ...healthyBase, ncOnboardingCompletedAt: null }), 'onboarding_pending');
    // not NC-bound → never onboarding_pending
    assert.notStrictEqual(store.computeHealth({ ...healthyBase, ncInstanceId: null, ncOnboardingCompletedAt: null }), 'onboarding_pending');
});

test('computeHealth: users_pending_approval when only pending users exist', () => {
    assert.strictEqual(store.computeHealth({
        ...healthyBase, users: { total: 3, active: 0, pending: 3 },
    }), 'users_pending_approval');
    // some users active → the org is not globally blocked on approval
    assert.notStrictEqual(store.computeHealth({
        ...healthyBase, users: { total: 3, active: 1, pending: 2 },
    }), 'users_pending_approval');
});

test('computeHealth: chat_failing on open error/critical chat problems', () => {
    assert.strictEqual(store.computeHealth({
        ...healthyBase,
        problems: [{ code: 'chat.provider_error', category: 'chat', severity: 'error' }],
    }), 'chat_failing');
    // info-level chat problem (dlp) does not flip health
    assert.strictEqual(store.computeHealth({
        ...healthyBase,
        problems: [{ code: 'chat.dlp_blocked', category: 'chat', severity: 'info' }],
    }), 'ok');
});

test('computeHealth: inactive = zero usage AND zero open problems, else ok', () => {
    assert.strictEqual(store.computeHealth({ ...healthyBase, messagesTotal: 0 }), 'inactive');
    assert.strictEqual(store.computeHealth({
        ...healthyBase, messagesTotal: 0,
        problems: [{ code: 'auth.blocked_geo', category: 'auth', severity: 'warning' }],
    }), 'ok', 'open problem means not silently inactive');
    assert.strictEqual(store.computeHealth(healthyBase), 'ok');
});

test('computeHealth: every outcome is a pinned enum value', () => {
    const outcomes = [
        store.computeHealth({}),
        store.computeHealth(healthyBase),
        store.computeHealth({ ...healthyBase, hasActiveSubscription: false }),
    ];
    for (const h of outcomes) assert.ok(store.HEALTH_STATES.includes(h), `unexpected health '${h}'`);
});

// ── getFleetOverview ───────────────────────────────────────────────────────

test('getFleetOverview maps orgs + orphans and computes health', async () => {
    getAllImpl = async (sql) => {
        if (sql.includes('FROM organizations')) {
            return [{
                id: 'org1', name: 'Acme', nc_base_url: 'https://nc.acme.nl', nc_instance_id: 'inst1',
                nc_provisioned_at: new Date('2026-07-01'), nc_last_sync_at: null, nc_onboarding_completed_at: null,
                has_active_subscription: true,
                total_users: 5, active_users: 0, pending_users: 5,
                messages_total: 0, messages_30d: 0, last_message_at: null,
                last_auth_ok_at: null, last_bootstrap_at: null, last_status_report_at: null, connector_version: null,
                problems: [],
            }];
        }
        return [{
            subject_key: 'nc:xyz', last_seen_at: new Date('2026-07-22'),
            problems: [{ code: 'bootstrap.verify_failed', severity: 'error' }],
        }];
    };
    const out = await store.getFleetOverview();
    assert.ok(out.generatedAt);
    assert.strictEqual(out.orgs.length, 1);
    const org = out.orgs[0];
    assert.strictEqual(org.id, 'org1');
    assert.strictEqual(org.ncBaseUrl, 'https://nc.acme.nl');
    assert.deepStrictEqual(org.users, { total: 5, active: 0, pending: 5 });
    assert.strictEqual(org.hasActiveSubscription, true);
    assert.strictEqual(org.health, 'onboarding_pending', 'wizard not completed wins over pending users');
    assert.strictEqual(out.orphans.length, 1);
    assert.strictEqual(out.orphans[0].subjectKey, 'nc:xyz');
    assert.strictEqual(out.orphans[0].problems[0].code, 'bootstrap.verify_failed');

    // Verify the aggregate SQL uses the verified schema facts.
    const orgQuery = calls.getAll.find(c => c.sql.includes('FROM organizations'));
    assert.match(orgQuery.sql, /'nextcloud_connector'/, 'only verified registration_source value');
    assert.match(orgQuery.sql, /"organizationId"/, 'users org column is quoted camelCase');
    assert.match(orgQuery.sql, /ai_usage_log/);
    assert.match(orgQuery.sql, /os\.status = 'active'/);
});

// ── pruneOld ───────────────────────────────────────────────────────────────

test('pruneOld deletes events, resolved problems and unattributed buckets', async () => {
    runImpl = async (sql) => {
        if (sql.includes('org_health_events')) return { rows: [], rowCount: 5 };
        if (sql.includes('resolved_at IS NOT NULL')) return { rows: [], rowCount: 2 };
        return { rows: [], rowCount: 1 };
    };
    const res = await store.pruneOld();
    assert.deepStrictEqual(res, { events: 5, resolvedProblems: 2, unattributed: 1 });
    assert.strictEqual(calls.run.length, 3);
    assert.deepStrictEqual(calls.run[0].params, [90], 'default event retention 90d');
    assert.deepStrictEqual(calls.run[1].params, [30], 'default resolved-problem retention 30d');
    assert.match(calls.run[2].sql, /domain:%/);
    assert.match(calls.run[2].sql, /'unknown'/);
});

test('pruneOld honours custom retention windows', async () => {
    runImpl = async () => ({ rows: [], rowCount: 0 });
    await store.pruneOld({ eventRetentionDays: 30, resolvedProblemRetentionDays: 7 });
    assert.deepStrictEqual(calls.run[0].params, [30]);
    assert.deepStrictEqual(calls.run[1].params, [7]);
});
