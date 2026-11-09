'use strict';

/**
 * checkResourceLimits on a self-hosted install: a subscription row left on an
 * organisation (Nextcloud provisioning assigns the Free plan) must not cap it.
 * The server licence governs there; only a licence seat cap still applies.
 *
 * Run: cd server && node --test core/entitlements/limits.selfHostedPlanCaps.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const userStore = require('../../stores/userStore');
const license = require('../../license/index');
const { checkResourceLimits } = require('./limits');
const { planResourceCapsApply } = require('../../license/planCaps.mts');

const FREE_PLAN = { status: 'active', max_users: 3, max_agents: 1, max_knowledge_sources: 5 };

/** @param {import('node:test').TestContext} t @param {string | undefined} mode */
function withMode(t, mode) {
    const before = process.env.DEPLOYMENT_MODE;
    if (mode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = mode;
    t.after(() => {
        if (before === undefined) delete process.env.DEPLOYMENT_MODE;
        else process.env.DEPLOYMENT_MODE = before;
    });
}

test('self-hosted: a Free-plan row does not cap agents or knowledge sources', async (t) => {
    withMode(t, 'self-hosted');
    t.mock.method(userStore, 'getEffectiveLimits', async () => FREE_PLAN);
    assert.equal(await checkResourceLimits('o1', 'agents', 1), null);
    assert.equal(await checkResourceLimits('o1', 'knowledge_sources', 50), null);
});

test('self-hosted: the Free-plan user cap is ignored, a licence seat cap still applies', async (t) => {
    withMode(t, 'self-hosted');
    t.mock.method(userStore, 'getEffectiveLimits', async () => FREE_PLAN);
    t.mock.method(license, 'getMaxSeatsForOrg', async () => null);
    assert.equal(await checkResourceLimits('o1', 'users', 10), null);
    t.mock.method(license, 'getMaxSeatsForOrg', async () => 10);
    assert.match(await checkResourceLimits('o1', 'users', 10), /limit of 10 users/);
});

test('cloud: the plan caps still bind', async (t) => {
    withMode(t, 'cloud');
    t.mock.method(userStore, 'getEffectiveLimits', async () => FREE_PLAN);
    assert.match(await checkResourceLimits('o1', 'agents', 1), /limit of 1 agents/);
    assert.equal(await checkResourceLimits('o1', 'agents', 0), null);
});

test('planResourceCapsApply: cloud is the default, every other mode is off', () => {
    assert.equal(planResourceCapsApply({}), true);
    assert.equal(planResourceCapsApply({ DEPLOYMENT_MODE: 'cloud' }), true);
    assert.equal(planResourceCapsApply({ DEPLOYMENT_MODE: 'self-hosted' }), false);
    assert.equal(planResourceCapsApply({ DEPLOYMENT_MODE: 'private-cloud' }), false);
});
