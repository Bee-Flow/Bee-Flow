// @typecheck
/**
 * The org-health seed migration — the one-shot classification of
 * already-broken NC orgs into org_health_problems — on a real Postgres: the
 * boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's
 * pool (testUtils/pglitePool.js). What it must do:
 *   - idempotent: a re-run adds nothing and leaves a reopened count alone
 *   - the no-subscription seeds match getEffectiveLimits semantics (NO row at
 *     all — a suspended/cancelled org is never seeded as community_fallback)
 *   - the auth.* seeds require a live nc_instance_id binding
 *   - severity/message/remediation come verbatim from the CODES catalog in
 *     server/services/orgHealth.js (single source of truth)
 *   - meta is metadata-only ({reason} marker, nothing else)
 *
 * Run: node --test server/migrations/org-health-seed-2026-07.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool(ladderPglite());
const { CODES } = require('../services/orgHealth');
const { up } = require('./org-health-seed-2026-07');
test.after(close);

test.beforeEach(async () => {
    await pg.exec('TRUNCATE org_health_problems; TRUNCATE organization_subscriptions, organizations CASCADE');
});

/** @param {string} id @param {Record<string, unknown>} [over] */
const org = (id, over = {}) => insertRow(pg, 'organizations', { id, name: id, nc_instance_id: `inst-${id}`, nc_onboarding_completed_at: '2026-01-01', ...over });
/** @param {string} orgId @param {string} status */
const sub = (orgId, status) => insertRow(pg, 'organization_subscriptions', { id: `sub-${orgId}`, organization_id: orgId, status });
let u = 0;
/** @param {string} orgId @param {Record<string, unknown>} over */
const user = (orgId, over) => insertRow(pg, 'users', { id: `hs-u${++u}`, username: `hs-u${u}`, organizationId: orgId, ...over });
/** code → sorted org ids */
async function seeded() {
    const { rows } = await pg.query('SELECT subject_key, organization_id, code FROM org_health_problems ORDER BY code, subject_key');
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const r of rows) {
        assert.equal(r.subject_key, r.organization_id, 'subject_key = organization_id = the org id (self-attributed rows)');
        (out[r.code] ||= []).push(r.subject_key);
    }
    return out;
}

test('seeds all four codes and returns per-code counts', async () => {
    await org('nosub');                                                          // both subscription seeds
    await org('wizard', { nc_onboarding_completed_at: null });                   // + onboarding, no sub either
    await sub('wizard', 'active');
    await org('approval', { nc_new_user_default_status: 'pending' });
    await sub('approval', 'active');
    await user('approval', { status: 'pending' });
    const res = await up();
    assert.deepEqual(res, { subscriptionBlocked: 1, communityFallback: 1, onboardingPending: 1, pendingApproval: 1 });
    assert.deepEqual(await seeded(), {
        'auth.blocked_onboarding_pending': ['wizard'],
        'auth.blocked_pending_approval': ['approval'],
        'bootstrap.community_fallback': ['nosub'],
        'chat.subscription_blocked': ['nosub'],
    });
});

test('re-run safety: a second run inserts nothing and leaves an existing row as it is', async () => {
    await org('nosub');
    await up();
    await pg.query("UPDATE org_health_problems SET count = 9 WHERE code = 'chat.subscription_blocked'");
    const res = await up();
    assert.deepEqual(res, { subscriptionBlocked: 0, communityFallback: 0, onboardingPending: 0, pendingApproval: 0 });
    const { rows } = await pg.query("SELECT count FROM org_health_problems WHERE code = 'chat.subscription_blocked'");
    assert.deepEqual(rows, [{ count: 9 }]);
});

test('subscription seeds: NO-row predicate, no status filter (getEffectiveLimits semantics); NC provenance only', async () => {
    await org('nosub');
    await org('suspended');
    await sub('suspended', 'suspended');
    await org('cancelled');
    await sub('cancelled', 'cancelled');
    await org('connector-reg', { nc_instance_id: null, registration_source: 'nextcloud_connector' });
    await org('plain', { nc_instance_id: null });
    await up();
    const s = await seeded();
    assert.deepEqual(s['chat.subscription_blocked'], ['connector-reg', 'nosub'],
        'suspended/cancelled rows are deliberate states, never seeded; a non-NC org is not in scope');
    assert.deepEqual(s['bootstrap.community_fallback'], ['connector-reg', 'nosub']);
});

test('onboarding seed requires a live binding and an incomplete wizard', async () => {
    for (const id of ['done', 'unbound', 'open']) {
        await org(id, {
            nc_onboarding_completed_at: id === 'done' ? '2026-01-01' : null,
            nc_instance_id: id === 'unbound' ? null : `inst-${id}`,
            registration_source: 'nextcloud_connector',
        });
        await sub(id, 'active');
    }
    await up();
    assert.deepEqual((await seeded())['auth.blocked_onboarding_pending'], ['open']);
});

test('pending-approval seed: pending default + pending users + no active non-admin', async () => {
    const pendingOrg = async (/** @type {string} */ id, /** @type {Record<string, unknown>} */ over = {}) => {
        await org(id, { nc_new_user_default_status: 'pending', ...over });
        await sub(id, 'active');
        await user(id, { status: 'pending' });
    };
    await pendingOrg('blocked');
    await pendingOrg('admins-only');
    await user('admins-only', { status: 'active', orgRole: 'org_admin' });
    await user('admins-only', { status: 'active', orgRole: 'admin' });
    await pendingOrg('has-member');
    await user('has-member', { status: 'active', orgRole: 'member' });
    await pendingOrg('null-status-member');
    await user('null-status-member', { status: null, orgRole: null });
    await pendingOrg('default-active', { nc_new_user_default_status: 'active' });
    await pendingOrg('unbound', { nc_instance_id: null, registration_source: 'nextcloud_connector' });
    await org('no-pending', { nc_new_user_default_status: 'pending' });
    await sub('no-pending', 'active');
    await up();
    assert.deepEqual((await seeded())['auth.blocked_pending_approval'], ['admins-only', 'blocked'],
        'both canonical and legacy admin roles are skipped by the active-non-admin exclusion');
});

test('severity/message/remediation come verbatim from the CODES catalog; meta is a {reason} marker', async () => {
    await org('nosub', { nc_onboarding_completed_at: null });
    await up();
    const { rows } = await pg.query('SELECT * FROM org_health_problems');
    assert.equal(rows.length, 3);
    for (const r of rows) {
        const def = CODES[r.code];
        assert.ok(def, `code ${r.code} exists in the catalog`);
        assert.equal(r.category, def.category);
        assert.equal(r.severity, def.severity);
        assert.equal(r.message, def.defaultMessage);
        assert.equal(r.remediation, def.remediation);
        assert.equal(r.source, 'migration:org-health-seed-2026-07');
        assert.deepEqual(Object.keys(r.meta), ['reason']);
    }
});
