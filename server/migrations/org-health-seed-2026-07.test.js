/**
 * Unit tests for the org-health seed migration — the one-shot classification
 * of already-broken NC orgs into org_health_problems.
 *
 * The pg layer is mocked via require.cache (mirrors
 * org-registration-source-2026-07.test.js), so no DB. Because every seed is a
 * single INSERT ... SELECT, the tests pin the CONTRACT of each statement:
 *   - idempotency by construction (ON CONFLICT (subject_key, code) DO NOTHING)
 *   - the no-subscription predicate matches getEffectiveLimits semantics
 *     (NO row at all — deliberately NOT filtered on os.status, so
 *     suspended/cancelled orgs are never seeded as community_fallback)
 *   - the auth.* seeds require a live nc_instance_id binding
 *   - severity/message/remediation params come verbatim from the CODES
 *     catalog in server/services/orgHealth.js (single source of truth)
 *   - meta is metadata-only ({reason} marker, nothing else)
 *
 * Run: node --test server/migrations/org-health-seed-2026-07.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── In-memory fake of server/db.js (must be installed BEFORE any require
// that transitively loads db.js — orgHealthStore runs its DDL at load) ─────
// NOTE: orgHealthStore executes its CREATE TABLE DDL at require time (module
// load), i.e. BEFORE any test body runs — so DDL-vs-INSERT ordering is pinned
// via the persistent `ddlDone` flag stamped onto every recorded INSERT,
// rather than by position in the (per-test-cleared) ops list.
const state = { ops: [], rowCountsByCode: {}, ddlDone: false };
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

const fakeDb = {
    async exec(sql) {
        const q = norm(sql);
        if (q.includes('CREATE TABLE IF NOT EXISTS org_health_problems')) state.ddlDone = true;
        state.ops.push({ kind: 'exec', sql: q });
    },
    async run(sql, params = []) {
        const q = norm(sql);
        state.ops.push({ kind: 'run', sql: q, params, ddlDone: state.ddlDone });
        if (q.startsWith('INSERT INTO org_health_problems')) {
            return { rowCount: state.rowCountsByCode[params[0]] || 0 };
        }
        return { rowCount: 0 };
    },
    async getOne() { return null; },
    async getAll() { return []; },
};

const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { CODES } = require('../services/orgHealth');
const { up } = require('./org-health-seed-2026-07');

const inserts = () => state.ops.filter(o => o.kind === 'run' && o.sql.startsWith('INSERT INTO org_health_problems'));
const insertFor = (code) => inserts().find(o => o.params[0] === code);

test.beforeEach(() => { state.ops = []; state.rowCountsByCode = {}; });

test('seeds all four codes and returns per-code counts from rowCount', async () => {
    state.rowCountsByCode = {
        'chat.subscription_blocked': 7,
        'bootstrap.community_fallback': 7,
        'auth.blocked_onboarding_pending': 3,
        'auth.blocked_pending_approval': 2,
    };
    const res = await up();
    assert.deepEqual(res, {
        subscriptionBlocked: 7,
        communityFallback: 7,
        onboardingPending: 3,
        pendingApproval: 2,
    });
    assert.equal(inserts().length, 4);
});

test('re-run safety: every INSERT carries ON CONFLICT (subject_key, code) DO NOTHING', async () => {
    await up();
    for (const op of inserts()) {
        assert.ok(op.sql.includes('ON CONFLICT (subject_key, code) DO NOTHING'),
            `idempotency clause missing on ${op.params[0]}`);
    }
});

test('store DDL runs before every seed INSERT', async () => {
    await up();
    assert.ok(state.ddlDone, 'orgHealthStore DDL executed');
    for (const op of inserts()) {
        assert.equal(op.ddlDone, true, `tables must exist before seeding ${op.params[0]}`);
    }
});

test('subscription seeds: NO-row predicate, no status filter (getEffectiveLimits semantics)', async () => {
    await up();
    for (const code of ['chat.subscription_blocked', 'bootstrap.community_fallback']) {
        const op = insertFor(code);
        assert.ok(op, `${code} seeded`);
        assert.ok(op.sql.includes('NOT EXISTS (SELECT 1 FROM organization_subscriptions os WHERE os.organization_id = o.id)'),
            `${code}: must target orgs with NO subscription row at all`);
        assert.ok(!op.sql.includes('os.status'),
            `${code}: suspended/cancelled/trialing rows are deliberate states — never filter on status`);
        // Broad NC provenance predicate (bound OR connector-registered).
        assert.ok(op.sql.includes("o.nc_instance_id IS NOT NULL OR o.registration_source = 'nextcloud_connector'"));
    }
});

test('onboarding seed requires a live binding and an incomplete wizard', async () => {
    await up();
    const op = insertFor('auth.blocked_onboarding_pending');
    assert.ok(op.sql.includes('o.nc_instance_id IS NOT NULL AND o.nc_onboarding_completed_at IS NULL'));
});

test('pending-approval seed: pending default + pending users + no active non-admin', async () => {
    await up();
    const op = insertFor('auth.blocked_pending_approval');
    assert.ok(op.sql.includes(`o.nc_new_user_default_status = 'pending'`));
    assert.ok(op.sql.includes(`u.status = 'pending'`));
    assert.ok(op.sql.includes(`COALESCE(u."orgRole", '') NOT IN ('org_admin', 'admin')`),
        'active-non-admin exclusion must skip both canonical and legacy admin roles');
    assert.ok(op.sql.includes('o.nc_instance_id IS NOT NULL'));
});

test('severity/message/remediation params come verbatim from the CODES catalog', async () => {
    await up();
    for (const op of inserts()) {
        const [code, category, severity, source, message, remediation, meta] = op.params;
        const def = CODES[code];
        assert.ok(def, `code ${code} exists in the catalog`);
        assert.equal(category, def.category);
        assert.equal(severity, def.severity);
        assert.equal(message, def.defaultMessage);
        assert.equal(remediation, def.remediation);
        assert.equal(source, 'migration:org-health-seed-2026-07');
        // meta is metadata-only: exactly a {reason} marker.
        assert.deepEqual(Object.keys(JSON.parse(meta)), ['reason']);
    }
});

test('subject_key = organization_id = the org id (self-attributed rows)', async () => {
    await up();
    for (const op of inserts()) {
        assert.ok(op.sql.includes('SELECT o.id, o.id,'), 'subject_key and organization_id both bind to o.id');
    }
});
