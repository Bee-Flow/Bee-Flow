/**
 * orgHealthStore against a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind db.js's pool
 * (testUtils/pglitePool.js). The upsert/reopen ledger, the keyset cursor, the
 * liveness upsert, the fleet aggregate and the retention sweep run their own
 * SQL; the pure computeHealth classifier is tested as a function.
 *
 * Run: cd server && node --test stores/orgHealthStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');

process.env.NODE_ENV = 'test';

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./orgHealthStore');

test.before(async () => { await store.initDB(); });
test.after(close);
test.beforeEach(async () => {
    await pg.exec('TRUNCATE org_health_problems, org_health_events, org_health_liveness RESTART IDENTITY');
});

const problems = async () => (await pg.query('SELECT * FROM org_health_problems ORDER BY id')).rows;
const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();

// ── initDB ─────────────────────────────────────────────────────────────────

test('initDB is memoized and idempotent: the tables exist, (subject_key, code) is unique', async () => {
    await store.initDB();
    await store.initDB();
    const { rows } = await pg.query(`SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('org_health_problems', 'org_health_events', 'org_health_liveness') ORDER BY 1`);
    assert.deepStrictEqual(rows.map(r => r.table_name), ['org_health_events', 'org_health_liveness', 'org_health_problems']);
    await insertRow(pg, 'org_health_problems', { subject_key: 's', code: 'c', category: 'auth', severity: 'info', source: 'x' });
    await assert.rejects(insertRow(pg, 'org_health_problems', { subject_key: 's', code: 'c', category: 'auth', severity: 'info', source: 'x' }), /unique|duplicate/i);
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

const blocked = {
    subjectKey: 'org1', organizationId: 'org1',
    code: 'chat.subscription_blocked', category: 'chat', severity: 'critical',
    source: 'limits', message: 'blocked', remediation: 'fix it', meta: { reason: 'no_subscription' },
};

test('upsertProblem: fresh insert → {inserted:true, reopened:false}, the row as given', async () => {
    const r = await store.upsertProblem(blocked);
    assert.deepStrictEqual(r, { inserted: true, reopened: false, count: 1 });
    const [row] = await problems();
    assert.deepStrictEqual(
        [row.subject_key, row.organization_id, row.code, row.category, row.severity, row.source, row.message, row.remediation, row.meta, row.count, row.resolved_at],
        ['org1', 'org1', 'chat.subscription_blocked', 'chat', 'critical', 'limits', 'blocked', 'fix it', { reason: 'no_subscription' }, 1, null],
    );
});

test('upsertProblem: recurrence → {inserted:false, reopened:false}, count bumped, one row, latest details win, org kept', async () => {
    await store.upsertProblem({ subjectKey: 'org1', organizationId: 'org1', code: 'auth.blocked_onboarding_pending', category: 'auth', severity: 'warning', message: 'first' });
    await store.upsertProblem({ subjectKey: 'org1', code: 'auth.blocked_onboarding_pending', category: 'auth', severity: 'warning', message: 'second' });
    const r = await store.upsertProblem({ subjectKey: 'org1', code: 'auth.blocked_onboarding_pending', category: 'auth', severity: 'error', message: 'third' });
    assert.deepStrictEqual(r, { inserted: false, reopened: false, count: 3 });
    const rows = await problems();
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual([rows[0].count, rows[0].message, rows[0].severity, rows[0].organization_id], [3, 'third', 'error', 'org1']);
});

test('upsertProblem: previously-resolved row → reopened:true, resolution cleared', async () => {
    const p = { subjectKey: 'nc:abc', code: 'bootstrap.verify_failed', category: 'bootstrap', severity: 'error' };
    await store.upsertProblem(p);
    await store.resolveProblems('nc:abc', ['bootstrap.verify_failed'], 'admin1');
    const r = await store.upsertProblem(p);
    assert.strictEqual(r.inserted, false);
    assert.strictEqual(r.reopened, true);
    const [row] = await problems();
    assert.deepStrictEqual([row.resolved_at, row.resolved_by, row.count], [null, null, 2]);
    assert.strictEqual((await store.upsertProblem(p)).reopened, false, 'an open row recurring is not a reopen');
});

test('upsertProblem: invalid severity coerced, missing essentials → null', async () => {
    await store.upsertProblem({ subjectKey: 's', code: 'c', category: 'auth', severity: 'apocalyptic' });
    assert.strictEqual((await problems())[0].severity, 'warning', 'bad severity must coerce to warning');
    assert.strictEqual(await store.upsertProblem({ code: 'x', category: 'auth' }), null);
    assert.strictEqual(await store.upsertProblem({ subjectKey: 's', category: 'auth' }), null);
    assert.strictEqual((await problems()).length, 1);
});

// ── resolveProblems ────────────────────────────────────────────────────────

test('resolveProblems returns the rows flipped: open ones only, by org or subject key, only the codes named', async () => {
    const base = { category: 'chat', severity: 'error' };
    await store.upsertProblem({ ...base, subjectKey: 'org1', organizationId: 'org1', code: 'chat.subscription_blocked' });
    await store.upsertProblem({ ...base, subjectKey: 'nc:1', organizationId: 'org1', code: 'chat.provider_error' });
    await store.upsertProblem({ ...base, subjectKey: 'org1', code: 'chat.other' });
    await store.upsertProblem({ ...base, subjectKey: 'org2', organizationId: 'org2', code: 'chat.provider_error' });
    await store.upsertProblem({ ...base, subjectKey: 'org1', code: 'chat.dlp_blocked' });
    await store.resolveProblems('org1', ['chat.dlp_blocked']);
    const n = await store.resolveProblems('org1', ['chat.subscription_blocked', 'chat.provider_error', 'chat.dlp_blocked'], 'system');
    assert.strictEqual(n, 2, 'the already-resolved row is not counted again');
    const open = (await problems()).filter(r => r.resolved_at === null).map(r => `${r.subject_key}/${r.code}`).sort();
    assert.deepStrictEqual(open, ['org1/chat.other', 'org2/chat.provider_error']);
    assert.strictEqual((await problems()).find(r => r.code === 'chat.subscription_blocked').resolved_by, 'system');
});

test('resolveProblems: empty codes or missing subject → 0, nothing touched', async () => {
    await store.upsertProblem({ subjectKey: 'org1', code: 'x', category: 'auth', severity: 'error' });
    assert.strictEqual(await store.resolveProblems('org1', []), 0);
    assert.strictEqual(await store.resolveProblems(null, ['x']), 0);
    assert.strictEqual((await problems())[0].resolved_at, null);
});

// ── appendEvent ────────────────────────────────────────────────────────────

test('appendEvent inserts with coerced actor kind and severity', async () => {
    const r = await store.appendEvent({
        subjectKey: 'org1', organizationId: 'org1', code: 'bootstrap.org_created',
        category: 'bootstrap', severity: 'nonsense', actorKind: 'hacker',
        message: 'created', meta: { a: 1 }, ip: '1.2.3.4',
    });
    assert.ok(r.id && r.created_at);
    const { rows: [ev] } = await pg.query('SELECT * FROM org_health_events WHERE id = $1', [r.id]);
    assert.strictEqual(ev.severity, 'info', 'invalid severity → info');
    assert.strictEqual(ev.actor_kind, 'system', 'invalid actorKind → system');
    assert.deepStrictEqual(ev.meta, { a: 1 });
    assert.strictEqual(ev.ip, '1.2.3.4');
});

// ── listProblems / listEvents ──────────────────────────────────────────────

test('listProblems maps rows to the pinned camelCase shape; default excludes resolved rows', async () => {
    await store.upsertProblem({ ...blocked, organizationId: 'org1' });
    await store.upsertProblem({ ...blocked });
    await store.upsertProblem({ subjectKey: 'org1', code: 'gone', category: 'chat', severity: 'error' });
    await store.resolveProblems('org1', ['gone']);
    await store.upsertProblem({ subjectKey: 'org2', organizationId: 'org2', code: 'theirs', category: 'chat', severity: 'error' });
    const rows = await store.listProblems({ organizationId: 'org1' });
    assert.strictEqual(rows.length, 1);
    const p = rows[0];
    assert.strictEqual(p.code, 'chat.subscription_blocked');
    assert.strictEqual(p.severity, 'critical');
    assert.strictEqual(p.count, 2);
    assert.ok(p.firstSeenAt instanceof Date && p.lastSeenAt instanceof Date);
    assert.strictEqual(p.resolvedAt, null);
    assert.deepStrictEqual(p.meta, { reason: 'no_subscription' });
    assert.deepStrictEqual((await store.listProblems({ organizationId: 'org1', includeResolved: true })).map(x => x.code).sort(),
        ['chat.subscription_blocked', 'gone']);
});

test('listProblems can narrow to one code (the backstop backoff read), open rows only', async () => {
    for (const k of ['nc:1', 'nc:2', 'nc:3']) await store.upsertProblem({ subjectKey: k, code: 'connector.nc_sync_failed', category: 'connector', severity: 'error' });
    await store.upsertProblem({ subjectKey: 'nc:1', code: 'other', category: 'connector', severity: 'error' });
    await store.resolveProblems('nc:3', ['connector.nc_sync_failed']);
    const rows = await store.listProblems({ code: 'connector.nc_sync_failed', limit: 500 });
    assert.deepStrictEqual(rows.map(r => r.subjectKey).sort(), ['nc:1', 'nc:2']);
});

/** Events of org1 at 2026-07-2<i>, newest last inserted. */
async function seedEvents(n, over = {}) {
    const ids = [];
    for (let i = 1; i <= n; i++) {
        ids.push((await insertRow(pg, 'org_health_events', {
            subject_key: 'org1', organization_id: 'org1', code: 'health.resolved', category: 'health',
            created_at: `2026-07-2${i}T00:00:00Z`, ...over,
        })).id);
    }
    return ids;
}

test('listEvents: keyset pagination returns nextCursor, trims to limit, and the next page carries on', async () => {
    const ids = await seedEvents(3);
    const { events, nextCursor } = await store.listEvents({ organizationId: 'org1', limit: 2 });
    assert.strictEqual(events.length, 2);
    assert.ok(nextCursor, 'must signal another page');
    assert.strictEqual(store._decodeCursor(nextCursor).id, ids[1], 'cursor points at last returned row');
    assert.strictEqual(events[0].createdAt.toISOString(), '2026-07-23T00:00:00.000Z');
    assert.strictEqual(events[0].actorKind, 'system');
    const page2 = await store.listEvents({ organizationId: 'org1', limit: 2, cursor: nextCursor });
    assert.deepStrictEqual(page2.events.map(e => e.id), [ids[0]]);
    assert.strictEqual(page2.nextCursor, null);
});

test('listEvents: rows sharing the cursor row\'s millisecond are not skipped (the keyset reads the row\'s own created_at)', async () => {
    const t = '2026-07-22 00:00:00.000';
    for (const us of ['100', '200', '300']) {
        await insertRow(pg, 'org_health_events', { subject_key: 'org1', organization_id: 'org1', code: 'c', category: 'health', created_at: `${t}${us}+00` });
    }
    const p1 = await store.listEvents({ organizationId: 'org1', limit: 1 });
    const p2 = await store.listEvents({ organizationId: 'org1', limit: 1, cursor: p1.nextCursor });
    const p3 = await store.listEvents({ organizationId: 'org1', limit: 1, cursor: p2.nextCursor });
    const seen = [...p1.events, ...p2.events, ...p3.events].map(e => e.id);
    assert.strictEqual(new Set(seen).size, 3, 'three distinct events over three pages');
});

test('listEvents: cursor + filters narrow the rows', async () => {
    const at = (d) => `2026-07-${d}T00:00:00Z`;
    const mk = (d, over = {}) => insertRow(pg, 'org_health_events', {
        subject_key: 'org1', organization_id: 'org1', code: 'chat.dlp_blocked', category: 'chat', severity: 'info', created_at: at(d), ...over,
    });
    const keep = await mk('10');
    await mk('11', { severity: 'warning' });
    await mk('12', { code: 'other' });
    await mk('13', { organization_id: 'org2', subject_key: 'org2' });
    await mk('05');                                        // before `since`
    const cursorRow = await mk('22');                      // the cursor row itself, excluded
    await mk('23');                                        // newer than the cursor
    const cursor = store._encodeCursor(cursorRow);
    const { events, nextCursor } = await store.listEvents({
        organizationId: 'org1', code: 'chat.dlp_blocked', severity: 'info',
        since: '2026-07-08', limit: 10, cursor,
    });
    assert.deepStrictEqual(events.map(e => e.id), [keep.id]);
    assert.strictEqual(nextCursor, null);
    const none = await store.listEvents({ organizationId: 'org1', limit: 10, cursor: store._encodeCursor({ created_at: new Date(at('01')), id: '00000000-0000-0000-0000-000000000009' }) });
    assert.deepStrictEqual(none.events, [], 'a cursor whose row is gone falls back to its timestamp');
});

// ── touchLiveness ──────────────────────────────────────────────────────────

test('touchLiveness upserts the right column flags and keeps the others', async () => {
    await store.touchLiveness('org1', { authOk: true });
    const { rows: [first] } = await pg.query('SELECT * FROM org_health_liveness WHERE organization_id = $1', ['org1']);
    assert.ok(first.last_auth_ok_at);
    assert.strictEqual(first.last_status_report_at, null);
    await store.touchLiveness('org1', { statusReport: true, connectorVersion: '1.2.3' });
    await store.touchLiveness('org1', { bootstrap: true });
    const { rows } = await pg.query('SELECT * FROM org_health_liveness');
    assert.strictEqual(rows.length, 1);
    const [l] = rows;
    assert.deepStrictEqual(l.last_auth_ok_at, first.last_auth_ok_at, 'a flag not passed keeps its time');
    assert.ok(l.last_status_report_at && l.last_bootstrap_at);
    assert.strictEqual(l.connector_version, '1.2.3', 'a missing version keeps the known one');
});

test('touchLiveness without orgId is a no-op', async () => {
    await store.touchLiveness(null, { authOk: true });
    assert.strictEqual((await pg.query('SELECT 1 FROM org_health_liveness')).rows.length, 0);
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

test('getFleetOverview maps connector orgs + orphans and computes health', async () => {
    await insertRow(pg, 'organizations', {
        id: 'fleet-org1', name: 'Acme', nc_base_url: 'https://nc.acme.nl', nc_instance_id: 'inst1',
        nc_provisioned_at: '2026-07-01T00:00:00Z',
    });
    await insertRow(pg, 'organizations', { id: 'fleet-org2', name: 'Bolt', registration_source: 'nextcloud_connector' });
    await insertRow(pg, 'organizations', { id: 'fleet-plain', name: 'Plain' });
    for (let i = 0; i < 5; i++) {
        await insertRow(pg, 'users', { id: `fleet-u${i}`, username: `fleet-u${i}`, organizationId: 'fleet-org1', status: 'pending' });
    }
    await insertRow(pg, 'users', { id: 'fleet-u9', username: 'fleet-u9', organizationId: 'fleet-org2', status: 'active' });
    await insertRow(pg, 'organization_subscriptions', { id: 'fleet-sub1', organization_id: 'fleet-org1', status: 'active' });
    await insertRow(pg, 'organization_subscriptions', { id: 'fleet-sub2', organization_id: 'fleet-org2', status: 'cancelled' });
    await store.upsertProblem({ subjectKey: 'nc:xyz', code: 'bootstrap.verify_failed', category: 'bootstrap', severity: 'error' });
    await store.upsertProblem({ subjectKey: 'nc:old', code: 'gone', category: 'bootstrap', severity: 'error' });
    await store.resolveProblems('nc:old', ['gone']);
    await store.upsertProblem({ subjectKey: 'fleet-org2', organizationId: 'fleet-org2', code: 'chat.provider_error', category: 'chat', severity: 'error' });

    const out = await store.getFleetOverview();
    assert.ok(out.generatedAt);
    const ids = out.orgs.map(o => o.id);
    assert.ok(ids.includes('fleet-org1') && ids.includes('fleet-org2'));
    assert.ok(!ids.includes('fleet-plain'), 'an org without a connector is not in the fleet');
    const org = out.orgs.find(o => o.id === 'fleet-org1');
    assert.strictEqual(org.ncBaseUrl, 'https://nc.acme.nl');
    assert.deepStrictEqual(org.users, { total: 5, active: 0, pending: 5 });
    assert.strictEqual(org.hasActiveSubscription, true);
    assert.strictEqual(org.health, 'onboarding_pending', 'wizard not completed wins over pending users');
    const bolt = out.orgs.find(o => o.id === 'fleet-org2');
    assert.strictEqual(bolt.hasActiveSubscription, false);
    assert.deepStrictEqual(bolt.problems.map(p => p.code), ['chat.provider_error']);
    assert.deepStrictEqual(out.orphans.map(o => o.subjectKey), ['nc:xyz'], 'resolved orphans drop out');
    assert.strictEqual(out.orphans[0].problems[0].code, 'bootstrap.verify_failed');
});

// ── pruneOld ───────────────────────────────────────────────────────────────

async function seedPrunable() {
    await insertRow(pg, 'org_health_events', { subject_key: 'o', code: 'c', category: 'x', created_at: daysAgo(100) });
    await insertRow(pg, 'org_health_events', { subject_key: 'o', code: 'c', category: 'x', created_at: daysAgo(40) });
    await insertRow(pg, 'org_health_events', { subject_key: 'o', code: 'c', category: 'x', created_at: daysAgo(1) });
    const p = { category: 'x', severity: 'error', source: 's' };
    await insertRow(pg, 'org_health_problems', { ...p, subject_key: 'o', code: 'old-resolved', resolved_at: daysAgo(40) });
    await insertRow(pg, 'org_health_problems', { ...p, subject_key: 'o', code: 'mid-resolved', resolved_at: daysAgo(10) });
    await insertRow(pg, 'org_health_problems', { ...p, subject_key: 'o', code: 'open-old', last_seen_at: daysAgo(60) });
    await insertRow(pg, 'org_health_problems', { ...p, subject_key: 'domain:x.nl', code: 'stale', last_seen_at: daysAgo(31) });
    await insertRow(pg, 'org_health_problems', { ...p, subject_key: 'unknown', code: 'fresh', last_seen_at: daysAgo(1) });
    await insertRow(pg, 'org_health_problems', { ...p, subject_key: 'nc:1', code: 'nc-stale', last_seen_at: daysAgo(31) });
}

test('pruneOld deletes old events, old resolved problems and stale unattributed buckets', async () => {
    await seedPrunable();
    const res = await store.pruneOld();
    assert.deepStrictEqual(res, { events: 1, resolvedProblems: 1, unattributed: 1 });
    assert.strictEqual((await pg.query('SELECT 1 FROM org_health_events')).rows.length, 2, 'default event retention 90d');
    assert.deepStrictEqual((await problems()).map(r => r.code).sort(), ['fresh', 'mid-resolved', 'nc-stale', 'open-old'],
        'resolved after 30d, domain:/unknown after 30d; nc: buckets and open rows stay');
});

test('pruneOld honours custom retention windows', async () => {
    await seedPrunable();
    const res = await store.pruneOld({ eventRetentionDays: 30, resolvedProblemRetentionDays: 7 });
    assert.deepStrictEqual(res, { events: 2, resolvedProblems: 2, unattributed: 1 });
});
