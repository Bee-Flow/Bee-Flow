/**
 * Build-stamped cross-process cache keys (bf:perms:/bf:uex:) — U3.
 *
 * The Redis permission/user-exists caches are shared by every pod behind the
 * same Redis. During a rolling deploy an old and a new build must never read
 * each other's snapshots, so buildKey() weaves APP_BUILD_SHA into every key.
 * These tests pin that contract:
 *   - the key a build writes, reads and invalidates carries its own stamp;
 *   - two different builds mint two different keys for the same user;
 *   - a value poisoned under another build's key is never served.
 *
 * buildInfo reads APP_BUILD_SHA once at require time, so each scenario evicts
 * permissions.js + buildInfo.js from require.cache and reloads them under the
 * desired stamp (same pattern as utils/buildInfo.test.js).
 *
 * Run: cd server && node --test --test-force-exit auth/permissions.cacheStamp.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const PERMISSIONS = path.join(SERVER, 'auth', 'permissions.js');
const BUILDINFO = path.join(SERVER, 'utils', 'buildInfo.js');

// ── Stub userStore + db so this is a pure unit test (no DB, no real Redis) ──
const fx = {
    users: {
        u1: { id: 'u1', role: 'user', orgRole: 'member', groups: [], organizationId: 'orgA' },
    },
};
let currentRedis = null;

const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => fx.users[id] || null,
        getAllGroups: async () => [],
        getAllRoles: async () => [],
    },
    '../db': { getRedis: () => currentRedis },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:cache-stamp:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

// The hook stays installed for the whole file: requireAuth lazily requires
// '../stores/userStore' at call time, long after module load.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // orgScope.js too: permissions.js delegates the org read to it, and a stub
    // keyed on the parent file alone would silently load the real userStore.
    if (parent && /auth[\\/](permissions|orgScope)\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
after(() => { Module._resolveFilename = originalResolve; });

// Fake Redis that records every key touched. Deliberately has NO `duplicate`,
// so permissions.js skips its pub/sub subscriber setup.
function makeFakeRedis() {
    const store = new Map();
    const ops = [];
    return {
        store,
        ops,
        async get(k) { ops.push(['get', k]); const v = store.get(k); return v === undefined ? null : v; },
        async set(k, v) { ops.push(['set', k]); store.set(k, String(v)); return 'OK'; },
        async del(...keys) { ops.push(['del', ...keys]); for (const k of keys) store.delete(k); return keys.length; },
        async publish() { return 0; },
    };
}

function loadPermissionsWithStamp(sha, redis) {
    currentRedis = redis;
    delete require.cache[PERMISSIONS];
    delete require.cache[BUILDINFO];
    process.env.APP_BUILD_SHA = sha;
    try {
        return require(PERMISSIONS);
    } finally {
        delete process.env.APP_BUILD_SHA;
        // Evict again so no later require in this process accidentally reuses
        // a module bound to this test's stamp.
        delete require.cache[PERMISSIONS];
        delete require.cache[BUILDINFO];
    }
}

test('bf:perms key is read, written and invalidated under the build stamp', async () => {
    const redis = makeFakeRedis();
    const perms = loadPermissionsWithStamp('stampA', redis);

    const result = await perms.getUserPermissions('u1');
    assert.ok(Array.isArray(result) && result.includes('page_chat'));

    const stamped = 'bf:perms:u1:bstampA';
    const permGets = redis.ops.filter(o => o[0] === 'get' && o[1].startsWith('bf:perms:'));
    const permSets = redis.ops.filter(o => o[0] === 'set' && o[1].startsWith('bf:perms:'));
    assert.ok(permGets.length >= 1 && permGets.every(o => o[1] === stamped), `reads must use ${stamped}`);
    assert.deepEqual(permSets.map(o => o[1]), [stamped], `write must use ${stamped}`);

    await perms.invalidatePermissionCache('u1');
    const permDels = redis.ops.filter(o => o[0] === 'del' && String(o[1]).startsWith('bf:perms:'));
    assert.deepEqual(permDels, [['del', stamped]], 'invalidation must delete the stamped key');
});

test('bf:uex key (requireAuth user-exists revalidation) carries the build stamp', async () => {
    const redis = makeFakeRedis();
    const perms = loadPermissionsWithStamp('stampA', redis);

    const req = {
        session: {
            isAuthenticated: true,
            user: { id: 'u1', role: 'user' },
            destroy(cb) { if (cb) cb(); },
        },
    };
    const res = { status() { return this; }, json() { return this; } };
    let reachedNext = false;
    await perms.requireAuth(req, res, () => { reachedNext = true; });
    assert.equal(reachedNext, true, 'existing user must pass requireAuth');

    const stamped = 'bf:uex:u1:bstampA';
    const uexSets = redis.ops.filter(o => o[0] === 'set' && o[1].startsWith('bf:uex:'));
    assert.deepEqual(uexSets.map(o => o[1]), [stamped]);

    await perms.invalidateUserExistenceCache('u1');
    const uexDels = redis.ops.filter(o => o[0] === 'del' && String(o[1]).startsWith('bf:uex:'));
    assert.deepEqual(uexDels, [['del', stamped]]);
});

test('two different build stamps mint two different keys for the same user', async () => {
    const redisA = makeFakeRedis();
    await loadPermissionsWithStamp('sha-old', redisA).getUserPermissions('u1');
    const keyA = redisA.ops.find(o => o[0] === 'set')[1];

    const redisB = makeFakeRedis();
    await loadPermissionsWithStamp('sha-new', redisB).getUserPermissions('u1');
    const keyB = redisB.ops.find(o => o[0] === 'set')[1];

    assert.ok(keyA.endsWith(':bsha-old'), keyA);
    assert.ok(keyB.endsWith(':bsha-new'), keyB);
    assert.notEqual(keyA, keyB);
});

test('a snapshot cached by another build is never served (rolling-deploy isolation)', async () => {
    // Shared Redis, as in a real rolling deploy: the OLD build has cached a
    // poisoned/differently-shaped value under ITS key. The NEW build must miss
    // it and resolve fresh.
    const redis = makeFakeRedis();
    redis.store.set('bf:perms:u1:bsha-old', JSON.stringify(['all']));

    const permsNew = loadPermissionsWithStamp('sha-new', redis);
    const result = await permsNew.getUserPermissions('u1');
    assert.ok(!result.includes('all'), `new build must not read the old build's snapshot, got ${JSON.stringify(result)}`);
});
