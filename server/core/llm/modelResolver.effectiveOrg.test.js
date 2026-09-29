/**
 * DB-free unit test for resolveEffectiveOrgId (M2a) — the getAllGroups killer.
 *
 * Stubs configStore (module load), auth/permissions.resolveUserOrgIds, and
 * userStore.getUser/getAllGroups. Verifies: direct-org fast path, super-admin
 * DB fallback, group scan, skipGroupFallback, per-user caching (a 2nd call
 * skips resolveUserOrgIds AND getAllGroups), and null when no user.
 *
 * Run: cd server && node --test --test-force-exit --test-timeout=30000 core/modelResolver.effectiveOrg.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

let orgIdsResult;              // what resolveUserOrgIds returns
let userRow;                   // what getUser returns
const calls = { resolveUserOrgIds: 0, getUser: 0, getAllGroups: 0 };

const restore = installResolveStub({
    '../../stores/configStore': { getConfig: async () => null },
    '../../auth/permissions': { resolveUserOrgIds: async () => { calls.resolveUserOrgIds++; return orgIdsResult; } },
    '../../stores/userStore': {
        getUser: async () => { calls.getUser++; return userRow; },
        getAllGroups: async () => { calls.getAllGroups++; return [{ id: 'g1', organizationId: 'org-from-group' }]; },
    },
});

const { resolveEffectiveOrgId } = require('./modelResolver');

function reset() { calls.resolveUserOrgIds = 0; calls.getUser = 0; calls.getAllGroups = 0; }

test('direct org from resolveUserOrgIds set — no DB fallback', async () => {
    reset();
    orgIdsResult = new Set(['org-A']);
    const org = await resolveEffectiveOrgId({}, { userId: 'u-direct' });
    assert.equal(org, 'org-A');
    assert.equal(calls.getUser, 0);
    assert.equal(calls.getAllGroups, 0);
});

test('super-admin (null set) → getUser.organizationId', async () => {
    reset();
    orgIdsResult = null;
    userRow = { organizationId: 'org-B', groups: [] };
    const org = await resolveEffectiveOrgId({}, { userId: 'u-super' });
    assert.equal(org, 'org-B');
    assert.equal(calls.getUser, 1);
    assert.equal(calls.getAllGroups, 0);
});

test('no direct org, group membership → getAllGroups scan', async () => {
    reset();
    orgIdsResult = new Set();
    userRow = { organizationId: null, groups: ['g1'] };
    const org = await resolveEffectiveOrgId({}, { userId: 'u-group' });
    assert.equal(org, 'org-from-group');
    assert.equal(calls.getAllGroups, 1);
});

test('skipGroupFallback → no group scan, returns null', async () => {
    reset();
    orgIdsResult = new Set();
    userRow = { organizationId: null, groups: ['g1'] };
    const org = await resolveEffectiveOrgId({}, { userId: 'u-nogrp', skipGroupFallback: true });
    assert.equal(org, null);
    assert.equal(calls.getAllGroups, 0);
});

test('caches per user — 2nd call skips resolveUserOrgIds + getAllGroups', async () => {
    reset();
    orgIdsResult = new Set();
    userRow = { organizationId: null, groups: ['g1'] };
    const a = await resolveEffectiveOrgId({}, { userId: 'u-cache' });
    const b = await resolveEffectiveOrgId({}, { userId: 'u-cache' });
    assert.equal(a, 'org-from-group');
    assert.equal(b, 'org-from-group');
    assert.equal(calls.resolveUserOrgIds, 1); // 2nd served from cache
    assert.equal(calls.getAllGroups, 1);
});

test('cache key separates skipGroupFallback variants', async () => {
    reset();
    orgIdsResult = new Set();
    userRow = { organizationId: null, groups: ['g1'] };
    const withGrp = await resolveEffectiveOrgId({}, { userId: 'u-variant' });
    const noGrp = await resolveEffectiveOrgId({}, { userId: 'u-variant', skipGroupFallback: true });
    assert.equal(withGrp, 'org-from-group');
    assert.equal(noGrp, null); // different cache slot, not the grp result
});

test('no userId and no session → null, no lookups', async () => {
    reset();
    orgIdsResult = new Set();
    const org = await resolveEffectiveOrgId({}, {});
    // resolveUserOrgIds still runs (it may read the req), but no user-keyed DB fallback/cache
    assert.equal(org, null);
    assert.equal(calls.getUser, 0);
});

test.after(() => restore());
