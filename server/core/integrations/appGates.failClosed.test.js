'use strict';

/**
 * The two app gates must DENY when the user / org / group lookup fails. They used
 * to carry on with "no allow-list, no deny-list", which is the widest answer.
 *
 * Run: cd server && node --test core/integrations/appGates.failClosed.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeAppGate } = require('./runtimeAppGate');
const { createUserAppGate } = require('./userAppGate');

const configStore = { getConfig: async () => null };
const lazyFor = (userStore) => ({
    userStore: () => userStore,
    entitlements: () => ({ resolveEntitlements: async () => ({ degraded: true }) }),
    capabilityRegistry: () => ({ getCapability: () => null }),
});
const healthyStore = { getUser: async () => ({ id: 'u1', groups: [] }), getOrganization: async () => null, getAllGroups: async () => [] };
const failingStore = { ...healthyStore, getUser: async () => { throw new Error('db down'); } };
const failingGroups = {
    getUser: async () => ({ id: 'u1', organizationId: 'o1', groups: ['g1'] }),
    getOrganization: async () => ({ id: 'o1' }),
    getAllGroups: async () => { throw new Error('db down'); },
};

const runtime = (store) => createRuntimeAppGate({
    configStore, resolveOrgAllowList: async () => null, resolveOrgActiveSet: async () => null, lazy: lazyFor(store),
});
const user = (store) => createUserAppGate({
    configStore, resolveOrgAllowList: async () => null, webpageToolsAllowed: async () => false, lazy: lazyFor(store),
});

test('runtime gate: healthy lookups still allow an app', async () => {
    const gate = await runtime(healthyStore)({ userId: 'u1' });
    assert.equal(gate.isAppOn('nextcloud-files'), true);
});

test('runtime gate: a failing user lookup denies every app', async () => {
    const gate = await runtime(failingStore)({ userId: 'u1' });
    assert.equal(gate.isAppOn('nextcloud-files'), false);
});

test('runtime gate: a failing group lookup denies every app', async () => {
    const gate = await runtime(failingGroups)({ userId: 'u1' });
    assert.equal(gate.isAppOn('nextcloud-files'), false);
});

test('user gate: healthy lookups still allow an app', async () => {
    const { isIntegrationPermittedForUser } = user(healthyStore);
    assert.equal(await isIntegrationPermittedForUser({ userId: 'u1', appId: 'nextcloud-files' }), true);
});

test('user gate: a failing user lookup denies the integration', async () => {
    const { isIntegrationPermittedForUser } = user(failingStore);
    assert.equal(await isIntegrationPermittedForUser({ userId: 'u1', appId: 'nextcloud-files' }), false);
});

test('user gate: a failing group lookup denies the integration', async () => {
    const { isIntegrationPermittedForUser } = user(failingGroups);
    assert.equal(await isIntegrationPermittedForUser({ userId: 'u1', appId: 'nextcloud-files' }), false);
});
