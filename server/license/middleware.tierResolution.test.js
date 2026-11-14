// @typecheck
/**
 * How resolveBestTierForRequest arrives at a tier: the caller's personal tier,
 * the organisations named on the session (`organizationId` and `orgId`), the
 * best of those, and the memo it leaves on the session.
 *
 * Run: cd server && node --test license/middleware.tierResolution.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const license = require('./index');
const middleware = require('./middleware');

/**
 * Tier lookups that answer without a database.
 * @param {import('node:test').TestContext} t
 * @param {{ user?: string, orgs?: Record<string, string>, spread?: string }} [tiers]
 */
function arrange(t, { user = 'community', orgs = {}, spread = 'community' } = {}) {
    return {
        resolveTier: t.mock.method(license, 'resolveTier', async () => user),
        getTierForOrg: t.mock.method(license, 'getTierForOrg', async (/** @type {string} */ id) => orgs[id] ?? 'community'),
        getBestTierForOrgs: t.mock.method(license, 'getBestTierForOrgs', async () => spread),
    };
}

/** @param {Record<string, unknown>} user */
const member = (user) => ({ session: { isAuthenticated: true, user: { role: 'user', ...user } } });
/** @param {string} id */
const admin = (id) => ({ session: { isAuthenticated: true, isAdmin: true, user: { id, role: 'admin' } } });
/** @param {{ session: Record<string, any> }} req */
const memo = (req) => Object.entries(req.session).find(([k]) => k.startsWith('_lic:'))?.[1];

test('the personal tier of a caller with an id counts; a caller without an id is not looked up', async (t) => {
    const calls = arrange(t, { user: 'enterprise' });
    const withId = await middleware.resolveBestTierForRequest(member({ id: 'u-personal' }));
    assert.equal(withId.userTier, 'enterprise');
    assert.equal(withId.tier, 'enterprise');
    assert.deepEqual(calls.resolveTier.mock.calls.map((c) => c.arguments[0]), [{ userId: 'u-personal' }]);

    const withoutId = await middleware.resolveBestTierForRequest(member({}));
    assert.equal(withoutId.userTier, 'community');
    assert.equal(calls.resolveTier.mock.callCount(), 1, 'no lookup for a session user without an id');
});

test('both organisation fields of the session are candidates, and the best of their tiers wins', async (t) => {
    const calls = arrange(t, { orgs: { 'org-legacy-field': 'enterprise' } });
    const out = await middleware.resolveBestTierForRequest(member({ id: 'u-orgs', organizationId: 'org-main', orgId: 'org-legacy-field' }));
    assert.deepEqual([...out.orgIds].sort(), ['org-legacy-field', 'org-main']);
    assert.deepEqual(out.orgTiers, { 'org-main': 'community', 'org-legacy-field': 'enterprise' });
    assert.equal(out.tier, 'enterprise');
    assert.equal(calls.getTierForOrg.mock.callCount(), 2);
});

test('a session without organisation fields asks for no organisation tier', async (t) => {
    const calls = arrange(t);
    const out = await middleware.resolveBestTierForRequest(admin('u-no-org'));
    assert.deepEqual(out.orgIds, [], 'an absent field is not a candidate');
    assert.equal(calls.getTierForOrg.mock.callCount(), 0);
});

test('the memo of a platform administrator lives into the future and answers the next request', async (t) => {
    const calls = arrange(t);
    const req = admin('u-admin');
    const before = Date.now();
    const first = await middleware.resolveBestTierForRequest(req);
    assert.equal(first.tier, 'full');
    assert.ok(memo(req).expiresAt > before, 'the memo expires after it was written');

    const second = await middleware.resolveBestTierForRequest(req);
    assert.equal(second, first, 'served from the memo');
    assert.equal(calls.resolveTier.mock.callCount(), 1);
});

test('a memo is used up to, not at, the moment it expires', async (t) => {
    const calls = arrange(t);
    const req = admin('u-expiry');
    await middleware.resolveBestTierForRequest(req);
    const expiresAt = memo(req).expiresAt;

    t.mock.method(Date, 'now', () => expiresAt - 1);
    await middleware.resolveBestTierForRequest(req);
    assert.equal(calls.resolveTier.mock.callCount(), 1, 'one millisecond before: the memo answers');

    t.mock.method(Date, 'now', () => expiresAt);
    await middleware.resolveBestTierForRequest(req);
    assert.equal(calls.resolveTier.mock.callCount(), 2, 'at the expiry itself: resolved again');
});

/** Run a gate; resolves with what it handed to `next` (`null` for a plain pass). */
const passedOn = (/** @type {Function} */ gate, /** @type {object} */ req) => new Promise((resolve, reject) => {
    const res = { status() { return this; }, json: (/** @type {unknown} */ body) => reject(new Error(`answered ${JSON.stringify(body)}`)) };
    Promise.resolve(gate(req, res, (/** @type {unknown} */ err) => resolve(err ?? null))).catch(reject);
});

test('when every organisation lookup fails the tier is unavailable, and the feature gate passes a 503 on', async (t) => {
    arrange(t);
    t.mock.method(license, 'getTierForOrg', async () => { throw new Error('database is away'); });
    // A plan grant must not open a gate whose tier could not be resolved.
    t.mock.method(license, 'orgGrantsFeature', async () => true);
    const req = () => member({ id: 'u-outage', organizationId: 'org-outage' });

    const asked = await middleware.featureAllowedForRequest(/** @type {import('express').Request} */ (/** @type {unknown} */ (req())), 'chat_basic');
    assert.equal(asked.allowed, false);
    assert.equal(asked.resolution.error, 'tier_unavailable');

    const err = /** @type {any} */ (await passedOn(middleware.requireFeature('chat_basic'), req()));
    assert.equal(err?.status, 503);
    assert.equal(err?.code, 'tier_unavailable');
});

test('a feature of the resolved tier is allowed, and the gate lets the request through', async (t) => {
    arrange(t, { orgs: { 'org-ent': 'enterprise' } });
    t.mock.method(license, 'orgGrantsFeature', async () => false);
    const req = () => member({ id: 'u-ent', organizationId: 'org-ent' });
    const asked = await middleware.featureAllowedForRequest(/** @type {import('express').Request} */ (/** @type {unknown} */ (req())), 'sso_saml');
    assert.equal(asked.allowed, true);
    assert.equal(asked.resolution.tier, 'enterprise');
    assert.equal(await passedOn(middleware.requireFeature('sso_saml'), req()), null);
});
