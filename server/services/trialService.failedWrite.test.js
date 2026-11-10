// @typecheck
/**
 * trialService: a trial whose subscription row could not be stored (the store
 * answers false on a database error) is not marked used, gets no history row
 * and no audit row, and the caller sees the failure.
 *
 * Run: cd server && node --test services/trialService.failedWrite.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const userStore = require('../stores/userStore');
const stripeService = require('./stripeService');
const trialService = require('./trialService');

const PLAN = { id: 'plan-1', trial_days: 14, stripe_price_id: 'price_1' };
const TRIAL = { trialEnd: '2030-01-01T00:00:00.000Z', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' };

/** Stub the store and Stripe on their own objects; `stored` is what the subscription write answers. */
function arrange(t, stored) {
    const calls = [];
    const stub = (obj, name, impl) => t.mock.method(obj, name, async (...args) => { calls.push(name); return impl(...args); });
    stub(userStore, 'getPlan', () => PLAN);
    stub(userStore, 'getOrganization', () => ({ id: 'org1', name: 'Acme', email: 'a@example.test' }));
    stub(userStore, 'getUser', () => ({ id: 'u1', email: 'u@example.test' }));
    stub(userStore, 'hasEmailUsedTrial', () => false);
    stub(userStore, 'getOrgSubscription', () => null);
    stub(userStore, 'getConsumerSubscription', () => null);
    stub(userStore, 'setOrgSubscription', () => stored);
    stub(userStore, 'setConsumerSubscription', () => stored);
    stub(userStore, 'markTrialUsed', () => true);
    stub(userStore, 'recordTrialHistory', () => true);
    stub(userStore, 'logSubscriptionAudit', () => true);
    stub(stripeService, 'isEnabled', () => true);
    stub(stripeService, 'createTrialSubscription', () => TRIAL);
    t.mock.method(require('./planEntitlements'), 'applyPlanToOrg', async () => {});
    return calls;
}

const AFTER_WRITE = ['markTrialUsed', 'recordTrialHistory', 'logSubscriptionAudit'];

test('an org trial whose row was not stored is not marked used', async (t) => {
    const calls = arrange(t, false);
    await assert.rejects(() => trialService.startOrgTrial('org1', 'plan-1'), /Failed to store the trial subscription/);
    assert.ok(calls.includes('setOrgSubscription'));
    assert.deepEqual(calls.filter((c) => AFTER_WRITE.includes(c)), []);
});

test('a consumer trial whose row was not stored is not marked used', async (t) => {
    const calls = arrange(t, false);
    await assert.rejects(() => trialService.startConsumerTrial('u1', 'plan-1'), /Failed to store the trial subscription/);
    assert.ok(calls.includes('setConsumerSubscription'));
    assert.deepEqual(calls.filter((c) => AFTER_WRITE.includes(c)), []);
});

test('a stored trial is marked used, recorded and audited', async (t) => {
    const calls = arrange(t, true);
    await trialService.startOrgTrial('org1', 'plan-1');
    await trialService.startConsumerTrial('u1', 'plan-1');
    assert.deepEqual(calls.filter((c) => AFTER_WRITE.includes(c)), [...AFTER_WRITE, ...AFTER_WRITE]);
});
