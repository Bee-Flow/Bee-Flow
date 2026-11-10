// @typecheck
/**
 * applyNcDefaultPlanIfConfigured: when the store could not write the
 * subscription (it answers false on a database error) the plan is NOT reported
 * as applied: no entitlements, no audit row, no bootstrap.plan_applied, and
 * the failure is recorded as bootstrap.plan_apply_failed. Bootstrap itself
 * still never throws. Stubs on the shared objects, no module mocking.
 *
 * Run: cd server && node --test auth/connector/provisioning.failedWrite.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const userStore = require('../../stores/userStore');
const { orgHealth, planEntitlements } = require('./serviceDeps');
const { applyNcDefaultPlanIfConfigured } = require('./provisioning');

/** `stored` is what the subscription write answers. */
function arrange(t, stored) {
    const calls = [];
    const stub = (obj, name, impl) => t.mock.method(obj, name, (...args) => { calls.push(name); return impl(...args); });
    stub(userStore, 'getDefaultNcPlan', async () => ({ id: 'plan-nc', name: 'Nextcloud' }));
    stub(userStore, 'setOrgSubscription', async () => stored);
    stub(userStore, 'logAccessAudit', async () => {});
    stub(planEntitlements, 'applyPlanToOrg', async () => {});
    stub(orgHealth, 'event', () => {});
    stub(orgHealth, 'resolve', () => {});
    stub(orgHealth, 'problem', (code) => { calls.push(code); });
    return calls;
}

test('a subscription that was not stored is not reported as an applied plan', async (t) => {
    const calls = arrange(t, false);
    await applyNcDefaultPlanIfConfigured('org1', 'test');
    assert.deepEqual(calls, ['getDefaultNcPlan', 'setOrgSubscription', 'problem', 'bootstrap.plan_apply_failed']);
});

test('a stored subscription applies the plan, audits it and resolves the health problems', async (t) => {
    const calls = arrange(t, true);
    await applyNcDefaultPlanIfConfigured('org1', 'test');
    assert.deepEqual(calls, ['getDefaultNcPlan', 'setOrgSubscription', 'applyPlanToOrg', 'logAccessAudit', 'event', 'resolve']);
});
