'use strict';

/**
 * checkSubscriptionLimits on a self-hosted server: the per-user monthly AI
 * budget (own limit, else the highest group limit). Cloud and every other
 * non-cloud mode keep their behaviour.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { checkSubscriptionLimits } = require('./limits');

const savedMode = process.env.DEPLOYMENT_MODE;
test.afterEach(() => {
    if (savedMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = savedMode;
});

/** Stub the reads; returns the calls the usage query received. */
function stub(t, { userLimit = null, groupLimits = [], cost = 0 }) {
    const usageCalls = [];
    t.mock.method(userStore, 'getCostLimitInputs', async () => ({ userLimit, groupLimits }));
    t.mock.method(usageStore, 'getUsageSummary', async (filters) => {
        usageCalls.push(filters);
        return { total_estimated_cost: cost };
    });
    return usageCalls;
}

test('self-hosted: under the limit passes', async (t) => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    const calls = stub(t, { userLimit: 10, cost: 9.99 });
    assert.equal(await checkSubscriptionLimits('org1', 'chat', 'u1'), null);
    assert.equal(calls[0].userId, 'u1');
    assert.equal(calls[0].organizationId, undefined, 'the budget covers all of the user\'s usage');
    const now = new Date();
    assert.equal(calls[0].startDate, new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), 'period starts on the 1st (server time)');
});

test('self-hosted: at or over the limit is blocked with a clear message', async (t) => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    stub(t, { userLimit: 10, cost: 10 });
    assert.match(await checkSubscriptionLimits('org1', 'chat', 'u1'), /monthly AI budget \(€10\.00\)\. Contact your administrator/);
    t.mock.restoreAll();
    stub(t, { userLimit: 10, cost: 25 });
    assert.match(await checkSubscriptionLimits(null, 'chat', 'u1'), /monthly AI budget/);
});

test('self-hosted: the group limit applies when the user has none', async (t) => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    stub(t, { groupLimits: [5, 20], cost: 12 });
    assert.equal(await checkSubscriptionLimits('org1', 'chat', 'u1'), null);
    t.mock.restoreAll();
    stub(t, { groupLimits: [5, 20], cost: 20 });
    assert.match(await checkSubscriptionLimits('org1', 'chat', 'u1'), /€20\.00/);
});

test('self-hosted: no limit means no usage query and no block', async (t) => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    const calls = stub(t, { cost: 9999 });
    assert.equal(await checkSubscriptionLimits('org1', 'chat', 'u1'), null);
    assert.equal(calls.length, 0);
});

test('self-hosted without a userId passes', async (t) => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    stub(t, { userLimit: 1, cost: 5 });
    assert.equal(await checkSubscriptionLimits('org1', 'chat', null), null);
});

test('self-hosted: an unreadable limit fails closed with 503', async (t) => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    t.mock.method(userStore, 'getCostLimitInputs', async () => { throw new Error('db down'); });
    await assert.rejects(() => checkSubscriptionLimits('org1', 'chat', 'u1'), (e) => e.status === 503 && e.code === 'cost_limit_unavailable');
});

test('other non-cloud modes return null without looking anything up', async (t) => {
    process.env.DEPLOYMENT_MODE = 'private-cloud';
    const get = t.mock.method(userStore, 'getCostLimitInputs', async () => ({ userLimit: 1, groupLimits: [] }));
    assert.equal(await checkSubscriptionLimits('org1', 'chat', 'u1'), null);
    assert.equal(get.mock.callCount(), 0);
});

test('cloud never reads the self-hosted budget', async (t) => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const get = t.mock.method(userStore, 'getCostLimitInputs', async () => ({ userLimit: 1, groupLimits: [] }));
    t.mock.method(userStore, 'getAllPlans', async () => []);
    assert.equal(await checkSubscriptionLimits(null, 'chat', 'u1'), null);
    assert.equal(get.mock.callCount(), 0);
});
