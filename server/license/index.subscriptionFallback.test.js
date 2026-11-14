'use strict';

/**
 * license/index.js getLicenseStatus on a cloud install without a licence row:
 * the subscription that decides the tier. An organisation subscription comes
 * first; the caller's own (consumer) subscription is asked only when no
 * organisation subscription gave more than Community. The stores are
 * stand-ins on the objects the licence module calls them through.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test license/index.subscriptionFallback.test.js
 */

process.env.NODE_ENV = 'test';
process.env.DEPLOYMENT_MODE = 'cloud';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('./store');
const subscriptions = require('../stores/user/subscriptions');
const license = require('./index');

const paid = (/** @type {string} */ planTier) => ({ status: 'active', payment_status: 'paid', plan_tier: planTier, plan_id: `plan-${planTier}`, plan_name: planTier });

/**
 * No licence rows anywhere; subscriptions as given.
 * @param {import('node:test').TestContext} t
 * @param {{ org?: Record<string, object>, consumer?: Record<string, object> }} subs
 */
function arrange(t, { org = {}, consumer = {} }) {
    t.mock.method(store, 'getActiveLicenseForServer', async () => null);
    t.mock.method(store, 'getActiveLicensesForOrgs', async () => []);
    t.mock.method(store, 'getActiveLicenseForUser', async () => null);
    t.mock.method(subscriptions, 'getEffectiveLimits', async () => null);
    license.bumpServerLicenseVersion();
    return {
        orgAsked: t.mock.method(subscriptions, 'getOrgSubscription', async (/** @type {string} */ id) => org[id] ?? null),
        consumerAsked: t.mock.method(subscriptions, 'getConsumerSubscription', async (/** @type {string} */ id) => consumer[id] ?? null),
    };
}

test('an organisation subscription decides, and the caller\'s own subscription is not asked', async (t) => {
    const calls = arrange(t, { org: { 'org-a': paid('enterprise') }, consumer: { 'u-1': paid('full') } });
    const status = await license.getLicenseStatus({ organizationId: 'org-a', userId: 'u-1' });
    assert.equal(status.tier, 'enterprise');
    assert.equal(status.source, 'stripe_subscription');
    assert.equal(status.subscription?.planId, 'plan-enterprise');
    assert.equal(status.scope, 'organization', 'the scope names where the tier comes from');
    assert.equal(calls.consumerAsked.mock.callCount(), 0);
});

test('without a paying organisation the caller\'s own subscription decides', async (t) => {
    const calls = arrange(t, { consumer: { 'u-1': paid('enterprise') } });
    const status = await license.getLicenseStatus({ organizationId: 'org-a', userId: 'u-1' });
    assert.equal(status.tier, 'enterprise');
    assert.equal(status.source, 'stripe_subscription');
    assert.equal(status.scope, 'consumer');
    assert.deepEqual(calls.consumerAsked.mock.calls.map((c) => c.arguments[0]), ['u-1']);
});

test('without a caller no consumer subscription is asked, and the tier is Community by default', async (t) => {
    const calls = arrange(t, {});
    const status = await license.getLicenseStatus({ organizationId: 'org-a' });
    assert.equal(status.tier, 'community');
    assert.equal(status.source, 'default');
    assert.equal(status.subscription, null);
    assert.equal(calls.consumerAsked.mock.callCount(), 0);
});

test('a subscription table that is not there yet is Community; any other failure of the read is not hidden', async (t) => {
    arrange(t, {});
    t.mock.method(store, 'getActiveLicenseForOrg', async () => null);
    t.mock.method(subscriptions, 'getOrgSubscription', async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); });
    assert.equal(await license.getTierForOrg('org-a'), 'community');
    t.mock.method(subscriptions, 'getOrgSubscription', async () => { throw new Error('connection reset'); });
    await assert.rejects(license.getTierForOrg('org-a'), /connection reset/);
});
