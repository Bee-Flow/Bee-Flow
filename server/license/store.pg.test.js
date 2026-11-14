'use strict';

/**
 * license/store.js against the real license_keys table on PGlite.
 *
 *   - an activation needs its id, token, tier and scope, and the binding its
 *     scope names (an organisation, a user)
 *   - activating supersedes the earlier active licence of the SAME target
 *     only: another organisation's or user's licence is left alone
 *   - the readers skip expired and revoked rows and never answer for another
 *     organisation
 *   - a failed refresh is grace inside the window and expired after it;
 *     revoking ends the target's sessions; extending revives an expired row
 *     but not a revoked one
 *
 * Run: cd server && node --test license/store.pg.test.js
 */

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const store = require('./store');
const { initDB: initUsers } = require('../stores/user/schema');
const sessionCache = require('../auth/sessionCache');

const DAY = 86400 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const ended = [];
const { swap, restore } = makeSwaps();

before(async () => {
    await initUsers();
    await pg.exec(`
        INSERT INTO organizations (id, name) VALUES ('org-a', 'A'), ('org-b', 'B');
        INSERT INTO users (id, username, "organizationId") VALUES ('u-a', 'ua', 'org-a'), ('u-b', 'ub', 'org-b'), ('u-x', 'ux', NULL);
    `);
    swap(sessionCache, 'endSessionsForOrg', async (orgId) => { ended.push(`org:${orgId}`); return 1; });
    swap(sessionCache, 'bustSessionsForUser', async (userId) => { ended.push(`user:${userId}`); return 1; });
});
after(async () => { restore(); await close(); });
beforeEach(async () => {
    ended.length = 0;
    await pg.exec('DELETE FROM license_keys; DELETE FROM subscription_audit_log;');
});

/** Activate a licence with sensible defaults; `over` names what the test is about. */
function activate(over) {
    return store.upsertLicense({
        rawToken: `tok-${over.licenseId}`, tier: 'enterprise', issuer: 'license.beeflow.nl',
        issuedAt: iso(-DAY), expiresAt: iso(30 * DAY), billingInterval: 'monthly', activatedBy: 'tester',
        ...over,
    });
}
const statusOf = async (id) => (await pg.query('SELECT refresh_status FROM license_keys WHERE id = $1', [id])).rows[0]?.refresh_status;
const auditActions = async () => (await pg.query('SELECT action, target_id FROM subscription_audit_log ORDER BY created_at, action')).rows;

// ── Activation refusals ─────────────────────────────────────────────────

test('an activation without id, token, tier or scope is refused and nothing is stored', async () => {
    const full = { licenseId: 'l1', rawToken: 't', tier: 'enterprise', scope: 'organization', organizationId: 'org-a', issuer: 'i', issuedAt: iso(0), expiresAt: iso(DAY) };
    for (const missing of ['licenseId', 'rawToken', 'tier', 'scope']) {
        await assert.rejects(store.upsertLicense({ ...full, [missing]: undefined }), /missing required fields/, missing);
    }
    assert.equal((await pg.query('SELECT 1 FROM license_keys')).rows.length, 0);
});

test('an organisation licence needs an organisation, a consumer licence a user', async () => {
    await assert.rejects(activate({ licenseId: 'l1', scope: 'organization' }), /organizationId required/);
    await assert.rejects(activate({ licenseId: 'l2', scope: 'consumer' }), /userId required/);
    assert.equal((await pg.query('SELECT 1 FROM license_keys')).rows.length, 0);
});

test('an activation is stored active, bound to its target, and audited', async () => {
    const lic = await activate({ licenseId: 'l1', scope: 'organization', organizationId: 'org-a', metadata: { max_seats: 5 } });
    assert.equal(lic.refreshStatus, 'active');
    assert.equal(lic.organizationId, 'org-a');
    assert.equal(lic.userId, null);
    assert.deepEqual(lic.metadata, { max_seats: 5 });
    assert.deepEqual(await auditActions(), [{ action: 'license_activated', target_id: 'org-a' }]);
});

// ── Superseding ─────────────────────────────────────────────────────────

test('a new organisation licence supersedes the old one of that organisation, not of another', async () => {
    await activate({ licenseId: 'a-old', scope: 'organization', organizationId: 'org-a' });
    await activate({ licenseId: 'b-only', scope: 'organization', organizationId: 'org-b' });
    await activate({ licenseId: 'a-new', scope: 'organization', organizationId: 'org-a' });
    assert.equal(await statusOf('a-old'), 'expired');
    assert.equal(await statusOf('a-new'), 'active');
    assert.equal(await statusOf('b-only'), 'active');
});

test('a new consumer licence supersedes that user\'s old one only', async () => {
    await activate({ licenseId: 'ua-old', scope: 'consumer', userId: 'u-a' });
    await activate({ licenseId: 'ub', scope: 'consumer', userId: 'u-b' });
    await activate({ licenseId: 'ua-new', scope: 'consumer', userId: 'u-a' });
    assert.equal(await statusOf('ua-old'), 'expired');
    assert.equal(await statusOf('ub'), 'active');
});

test('a new server licence supersedes the old server licence and leaves organisation licences alone', async () => {
    await activate({ licenseId: 's-old', scope: 'server' });
    await activate({ licenseId: 'org', scope: 'organization', organizationId: 'org-a' });
    await activate({ licenseId: 's-new', scope: 'server' });
    assert.equal(await statusOf('s-old'), 'expired');
    assert.equal(await statusOf('org'), 'active');
    assert.equal((await store.getActiveLicenseForServer()).id, 's-new');
});

test('a superseding sweep does not touch a revoked row, in any scope', async () => {
    for (const [scope, target] of [['organization', { organizationId: 'org-a' }], ['consumer', { userId: 'u-a' }], ['server', {}]]) {
        await activate({ licenseId: `gone-${scope}`, scope, ...target });
        await store.markRevoked(`gone-${scope}`, 'refund');
        await activate({ licenseId: `next-${scope}`, scope, ...target });
        assert.equal(await statusOf(`gone-${scope}`), 'revoked', scope);
    }
});

// ── Readers ─────────────────────────────────────────────────────────────

test('the active licence of an organisation is its latest live row, never another organisation\'s', async () => {
    await activate({ licenseId: 'b', scope: 'organization', organizationId: 'org-b', issuedAt: iso(-1000) });
    assert.equal(await store.getActiveLicenseForOrg('org-a'), null);
    await activate({ licenseId: 'a1', scope: 'organization', organizationId: 'org-a', issuedAt: iso(-2 * DAY) });
    assert.equal((await store.getActiveLicenseForOrg('org-a')).id, 'a1');
    await store.markRevoked('a1');
    assert.equal(await store.getActiveLicenseForOrg('org-a'), null, 'a revoked licence is not active');
    assert.equal(await store.getActiveLicenseForOrg(''), null);
    assert.equal(await store.getActiveLicenseForOrg(/** @type {any} */ (null)), null);
});

test('the active licence of a user skips expired rows', async () => {
    await activate({ licenseId: 'u1', scope: 'consumer', userId: 'u-a' });
    assert.equal((await store.getActiveLicenseForUser('u-a')).id, 'u1');
    await store.deactivateLicense('u1', 'tester');
    assert.equal(await store.getActiveLicenseForUser('u-a'), null);
    assert.equal(await store.getActiveLicenseForUser('u-b'), null);
    assert.equal(await store.getActiveLicenseForUser(''), null);
});

test('the licences across a set of organisations include their members\' own licences and nothing outside the set', async () => {
    await activate({ licenseId: 'org-a-lic', scope: 'organization', organizationId: 'org-a' });
    await activate({ licenseId: 'member-a', scope: 'consumer', userId: 'u-a' });
    await activate({ licenseId: 'member-b', scope: 'consumer', userId: 'u-b' });
    await activate({ licenseId: 'loner', scope: 'consumer', userId: 'u-x' });
    const ids = (await store.getActiveLicensesForOrgs(['org-a'])).map((l) => l.id).sort();
    assert.deepEqual(ids, ['member-a', 'org-a-lic']);
    assert.deepEqual(await store.getActiveLicensesForOrgs([]), []);
    assert.deepEqual(await store.getActiveLicensesForOrgs(/** @type {any} */ ('org-a')), []);
});

test('only live monthly licences that have not been confirmed within the window need a refresh', async () => {
    await activate({ licenseId: 'monthly-new', scope: 'organization', organizationId: 'org-a' });
    await activate({ licenseId: 'yearly', scope: 'organization', organizationId: 'org-b', billingInterval: 'yearly' });
    await activate({ licenseId: 'monthly-fresh', scope: 'consumer', userId: 'u-a' });
    await store.markRefreshSuccess('monthly-fresh');
    await activate({ licenseId: 'monthly-revoked', scope: 'consumer', userId: 'u-b' });
    await store.markRevoked('monthly-revoked');
    const due = (await store.getLicensesNeedingRefresh(3600)).map((l) => l.id);
    assert.deepEqual(due, ['monthly-new']);
    await pg.query(`UPDATE license_keys SET last_refresh_at = NOW() - interval '2 hours' WHERE id = 'monthly-fresh'`);
    assert.deepEqual((await store.getLicensesNeedingRefresh(3600)).map((l) => l.id).sort(), ['monthly-fresh', 'monthly-new']);
});

// ── Refresh outcomes ────────────────────────────────────────────────────

test('a refresh success with a new token replaces the token and expiry and marks the row active', async () => {
    await activate({ licenseId: 'l1', scope: 'organization', organizationId: 'org-a' });
    await pg.query(`UPDATE license_keys SET refresh_status = 'grace' WHERE id = 'l1'`);
    const newExpiry = iso(90 * DAY);
    await store.markRefreshSuccess('l1', { newToken: 'tok-renewed', newExpiresAt: newExpiry });
    const lic = await store.getLicenseById('l1');
    assert.equal(lic.rawToken, 'tok-renewed');
    assert.equal(new Date(lic.expiresAt).toISOString(), newExpiry);
    assert.equal(lic.refreshStatus, 'active');
    assert.ok(lic.lastRefreshAt);
});

test('a refresh success without a token keeps the token', async () => {
    await activate({ licenseId: 'l1', scope: 'organization', organizationId: 'org-a' });
    await store.markRefreshSuccess('l1', {});
    assert.equal((await store.getLicenseById('l1')).rawToken, 'tok-l1');
});

test('a failed refresh inside the grace window is grace, outside it expired and audited', async () => {
    await activate({ licenseId: 'young', scope: 'organization', organizationId: 'org-a', issuedAt: iso(-1 * DAY) });
    await activate({ licenseId: 'old', scope: 'organization', organizationId: 'org-b', issuedAt: iso(-20 * DAY) });
    await store.markRefreshFailure('young', { graceWindowSeconds: 10 * 86400 });
    await store.markRefreshFailure('old', { graceWindowSeconds: 10 * 86400 });
    assert.equal(await statusOf('young'), 'grace');
    assert.equal(await statusOf('old'), 'expired');
    const audits = (await auditActions()).filter((a) => a.action === 'license_expired_after_grace');
    assert.deepEqual(audits, [{ action: 'license_expired_after_grace', target_id: 'org-b' }]);
});

test('the grace window runs from the last good refresh, not from issue', async () => {
    await activate({ licenseId: 'l1', scope: 'organization', organizationId: 'org-a', issuedAt: iso(-60 * DAY) });
    await store.markRefreshSuccess('l1');
    await store.markRefreshFailure('l1', { graceWindowSeconds: 86400 });
    assert.equal(await statusOf('l1'), 'grace');
    await pg.query(`UPDATE license_keys SET last_refresh_at = NOW() - interval '2 days' WHERE id = 'l1'`);
    await store.markRefreshFailure('l1', { graceWindowSeconds: 86400 });
    assert.equal(await statusOf('l1'), 'expired');
});

test('a refresh failure, revocation, extension or deactivation of an unknown id changes nothing', async () => {
    await store.markRefreshFailure('nope');
    await store.markRevoked('nope');
    assert.equal(await store.extendExpiry('nope', iso(DAY), 'tester'), null);
    assert.equal(await store.deactivateLicense('nope', 'tester'), false);
    assert.deepEqual(await auditActions(), []);
    assert.deepEqual(ended, []);
});

// ── Revoke, extend, deactivate ──────────────────────────────────────────

test('revoking an organisation licence ends that organisation\'s sessions; a consumer licence the user\'s', async () => {
    await activate({ licenseId: 'org', scope: 'organization', organizationId: 'org-a' });
    await activate({ licenseId: 'usr', scope: 'consumer', userId: 'u-b' });
    await store.markRevoked('org', 'refund');
    await store.markRevoked('usr');
    assert.deepEqual(ended, ['org:org-a', 'user:u-b']);
    const lic = await store.getLicenseById('org');
    assert.equal(lic.refreshStatus, 'revoked');
    assert.ok(lic.revokedAt);
});

test('extending revives an expired licence but leaves a revoked one revoked', async () => {
    await activate({ licenseId: 'exp', scope: 'organization', organizationId: 'org-a' });
    await activate({ licenseId: 'rev', scope: 'organization', organizationId: 'org-b' });
    await store.deactivateLicense('exp', 'tester');
    await store.markRevoked('rev');
    const later = new Date(Date.now() + 100 * DAY);
    const extended = await store.extendExpiry('exp', later, 'tester');
    assert.equal(extended.refreshStatus, 'active');
    assert.equal(new Date(extended.expiresAt).toISOString(), later.toISOString());
    assert.equal((await store.extendExpiry('rev', later.toISOString(), 'tester')).refreshStatus, 'revoked');
});

test('re-activating the same licence id brings a revoked row back as active', async () => {
    await activate({ licenseId: 'l1', scope: 'organization', organizationId: 'org-a' });
    await store.markRevoked('l1');
    const again = await activate({ licenseId: 'l1', scope: 'organization', organizationId: 'org-a', rawToken: 'tok-again' });
    assert.equal(again.refreshStatus, 'active');
    assert.equal(again.revokedAt, null);
    assert.equal(again.rawToken, 'tok-again');
});

test('the admin-issued list is filtered by issuer and organisation, and can leave out inactive rows', async () => {
    await activate({ licenseId: 'adm-a', scope: 'organization', organizationId: 'org-a', issuer: 'beeflow.admin.console' });
    await activate({ licenseId: 'adm-b', scope: 'organization', organizationId: 'org-b', issuer: 'beeflow.admin.console' });
    await activate({ licenseId: 'paid-a', scope: 'consumer', userId: 'u-a' });
    await store.deactivateLicense('adm-b', 'tester');
    assert.deepEqual((await store.getAdminIssuedLicenses()).map((l) => l.id).sort(), ['adm-a', 'adm-b']);
    assert.deepEqual((await store.getAdminIssuedLicenses({ organizationId: 'org-b' })).map((l) => l.id), ['adm-b']);
    assert.deepEqual((await store.getAdminIssuedLicenses({ includeInactive: false })).map((l) => l.id), ['adm-a']);
});

test('a metadata column that does not parse reads as an empty object', () => {
    const { rowToLicense, parseJSON } = store._internal;
    assert.equal(rowToLicense(null), null);
    assert.deepEqual(rowToLicense({ id: 'x', metadata: '{not json' }).metadata, {});
    assert.deepEqual(parseJSON('', { d: 1 }), { d: 1 });
    assert.deepEqual(parseJSON(/** @type {any} */ ({ a: 1 }), {}), { a: 1 });
});
