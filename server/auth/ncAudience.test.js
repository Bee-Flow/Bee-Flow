/**
 * auth/ncAudience — "is this caller's org a Nextcloud org, and may it see the
 * plans flagged nc_only?".
 *
 * Two signals count as NC (the definition orgHealthStore.getFleetOverview
 * uses): nc_instance_id set, or registration_source = 'nextcloud_connector'.
 * The predicate must fail CLOSED — a missing org, a consumer session or an
 * unknown id must never unlock a restricted plan.
 *
 * DB-free: stores/userStore and auth/permissions are replaced in require.cache.
 *
 * Run: cd server && node --test auth/ncAudience.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

let orgs = {};
let users = {};
let orgIdsForRequest = new Set();

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/userStore', {
    getOrganization: async (id) => orgs[id] || null,
    getUser: async (id) => users[id] || null,
});

stub('./permissions', {
    resolveUserOrgIds: async () => orgIdsForRequest,
});

const { isNcOrg, resolveOrgIdForRequest, resolveNcContextForRequest, filterNcOnlyPlans } = require('./ncAudience');

test.beforeEach(() => {
    orgs = {};
    users = {};
    orgIdsForRequest = new Set();
});

// ── isNcOrg ─────────────────────────────────────────────────────────────────

test('an org bound to a Nextcloud instance is an NC org', async () => {
    orgs.org_1 = { id: 'org_1', nc_instance_id: 'nc-abc' };
    assert.strictEqual(await isNcOrg('org_1'), true);
});

test('registration_source alone qualifies — an unbound NC org stays an NC customer', async () => {
    orgs.org_1 = { id: 'org_1', registrationSource: 'nextcloud_connector' };
    assert.strictEqual(await isNcOrg('org_1'), true);

    // parseOrg spreads the raw row, so the snake_case form must work too.
    orgs.org_2 = { id: 'org_2', registration_source: 'nextcloud_connector' };
    assert.strictEqual(await isNcOrg('org_2'), true);
});

test('a directly-registered org is not an NC org', async () => {
    orgs.org_1 = { id: 'org_1', registrationSource: 'direct' };
    assert.strictEqual(await isNcOrg('org_1'), false);
});

test('a missing or unknown org fails closed', async () => {
    assert.strictEqual(await isNcOrg(null), false);
    assert.strictEqual(await isNcOrg(undefined), false);
    assert.strictEqual(await isNcOrg('does_not_exist'), false);
});

test('a store failure propagates rather than resolving to "yes"', async () => {
    const userStore = require('../stores/userStore');
    const orig = userStore.getOrganization;
    userStore.getOrganization = async () => { throw new Error('db down'); };
    try {
        await assert.rejects(() => isNcOrg('org_1'), /db down/);
    } finally {
        userStore.getOrganization = orig;
    }
});

// ── request resolution ──────────────────────────────────────────────────────

test('the org id comes from the session when it carries one', async () => {
    const req = { session: { user: { id: 'u1', organizationId: 'org_1' } } };
    assert.strictEqual(await resolveOrgIdForRequest(req), 'org_1');
});

test('membership via a group still resolves — the session need not carry the org', async () => {
    orgIdsForRequest = new Set(['org_9']);
    orgs.org_9 = { id: 'org_9', nc_instance_id: 'nc-xyz' };
    const req = { session: { user: { id: 'u1' } } };

    assert.strictEqual(await resolveOrgIdForRequest(req), 'org_9');
    assert.strictEqual(await resolveNcContextForRequest(req), true);
});

test('a DB lookup is the last resort when neither session nor RBAC has the org', async () => {
    users.u1 = { id: 'u1', organizationId: 'org_3' };
    orgs.org_3 = { id: 'org_3', registrationSource: 'nextcloud_connector' };
    const req = { session: { user: { id: 'u1' } } };

    assert.strictEqual(await resolveNcContextForRequest(req), true);
});

test('a consumer session (no org anywhere) is never an NC audience', async () => {
    const req = { session: { user: { id: 'u2', isConsumerAccount: true } } };
    assert.strictEqual(await resolveNcContextForRequest(req), false);
});

test('an anonymous request is never an NC audience', async () => {
    assert.strictEqual(await resolveNcContextForRequest({}), false);
});

// ── filterNcOnlyPlans ───────────────────────────────────────────────────────

test('nc_only plans are dropped for a non-NC caller and kept for an NC one', () => {
    const plans = [{ id: 'open' }, { id: 'nc', nc_only: true }];

    assert.deepStrictEqual(filterNcOnlyPlans(plans, false).map(p => p.id), ['open']);
    assert.deepStrictEqual(filterNcOnlyPlans(plans, true).map(p => p.id), ['open', 'nc']);
});

test('a non-array input yields an empty list rather than throwing', () => {
    assert.deepStrictEqual(filterNcOnlyPlans(null, true), []);
    assert.deepStrictEqual(filterNcOnlyPlans(undefined, false), []);
});
