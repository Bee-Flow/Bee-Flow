// @typecheck
/**
 * What requireTier and requireFeature tell a refused caller: the gate that
 * stopped them, the tier they need, the tier they are on and where to upgrade.
 * The tier RESOLUTION (every organisation the caller belongs to and the tier
 * of each) stays in the server log; it is not part of the 403.
 *
 * Run: cd server && node --test license/middleware.refusalBody.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const license = require('./index');
const middleware = require('./middleware');

/** A member of an organisation on community; the tier lookups answer without a database. */
function arrange(t) {
    t.mock.method(license, 'resolveTier', async () => 'community');
    t.mock.method(license, 'getBestTierForOrgs', async () => 'community');
    t.mock.method(license, 'orgGrantsFeature', async () => false);
    t.mock.method(license, 'getTierForOrg', async () => 'community');
    return { session: { isAuthenticated: true, user: { id: 'u1', role: 'user', organizationId: 'org-acme' } } };
}

/** Run a gate; resolves with the response it wrote, or `{ next: true }`. */
function run(gate, req) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ status: this.statusCode, body }); return this; },
        };
        Promise.resolve(gate(req, res, (err) => (err ? reject(err) : resolve({ next: true })))).catch(reject);
    });
}

test('requireTier refuses with the gate, both tiers and the upgrade link, and nothing else', async (t) => {
    const out = await run(middleware.requireTier('enterprise'), arrange(t));
    assert.equal(out.status, 403);
    assert.deepEqual(Object.keys(out.body).sort(), ['current', 'error', 'required', 'upgrade_url']);
    assert.equal(out.body.error, 'tier_required');
    assert.equal(out.body.required, 'enterprise');
    assert.equal(out.body.current, 'community');
    assert.equal(JSON.stringify(out.body).includes('org-acme'), false, 'no organisation ids in the body');
});

test('requireFeature refuses the same way, naming the feature', async (t) => {
    const out = await run(middleware.requireFeature('blueprint_packaging'), arrange(t));
    assert.equal(out.status, 403);
    assert.deepEqual(Object.keys(out.body).sort(), ['current', 'error', 'feature', 'required', 'upgrade_url']);
    assert.equal(out.body.error, 'feature_locked');
    assert.equal(out.body.feature, 'blueprint_packaging');
    assert.equal(JSON.stringify(out.body).includes('org-'), false, 'no organisation ids in the body');
});
