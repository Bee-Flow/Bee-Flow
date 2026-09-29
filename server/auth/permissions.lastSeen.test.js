/**
 * "Last seen" is written from the request path, so the throttle is the feature.
 *
 * B15 puts the whole answer in one column, `users.last_seen_at`, written when a
 * session is active. The naive version of that adds a write to every
 * authenticated request in the product — for a field nobody reads more precisely
 * than "yesterday". So requireAuth stamps at most once per user per window, and
 * these tests pin the three properties that make it safe to leave in the hot
 * path:
 *
 *   - one write per user per window, however many requests arrive;
 *   - never for a caller who is not authenticated, or whose account is gone —
 *     an activity clock that anonymous traffic can move says nothing;
 *   - never fatal. A failing write must not slow the request down, must not
 *     fail it, and must not surface as an unhandled rejection.
 *
 * requireAuth is exercised for real; only userStore and Redis are doubles. The
 * module-eviction dance is the one from permissions.cacheStamp.test.js —
 * permissions.js reads its window size once, at require time.
 *
 * Run: cd server && node --test --test-force-exit auth/permissions.lastSeen.test.js
 */

process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const PERMISSIONS = path.join(SERVER, 'auth', 'permissions.js');

const fx = { user: { id: 'u1', role: 'user', groups: [], organizationId: 'orgA' } };
const touched = [];          // every touchLastSeen(userId)
let touchThrows = null;
let currentRedis = null;

const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => (id === fx.user.id ? fx.user : null),
        getAllGroups: async () => [],
        getAllRoles: async () => [],
        touchLastSeen: async (userId) => {
            touched.push(userId);
            if (touchThrows) throw new Error(touchThrows);
            return true;
        },
    },
    '../db': { getRedis: () => currentRedis },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:last-seen:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // orgScope.js too: permissions.js delegates the org read to it, and a stub
    // keyed on the parent file alone would silently load the real userStore.
    if (parent && /auth[\\/](permissions|orgScope)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
after(() => { Module._resolveFilename = originalResolve; });

/** Fake Redis recording every op. No `duplicate`, so no pub/sub subscriber. */
function makeFakeRedis({ nxWins = true } = {}) {
    const ops = [];
    return {
        ops,
        async get() { return null; },
        async set(k, ...args) { ops.push({ key: k, args }); return nxWins ? 'OK' : null; },
        async del() { return 1; },
        async publish() { return 0; },
    };
}

function loadPermissions({ windowSeconds = 900, redis = null } = {}) {
    currentRedis = redis;
    delete require.cache[PERMISSIONS];
    process.env.LAST_SEEN_WINDOW = String(windowSeconds);
    try {
        return require(PERMISSIONS);
    } finally {
        delete process.env.LAST_SEEN_WINDOW;
        delete require.cache[PERMISSIONS];
    }
}

function authedReq(userId = 'u1') {
    return {
        session: {
            isAuthenticated: true,
            user: { id: userId, role: 'user' },
            destroy(cb) { this.destroyed = true; if (cb) cb(); },
        },
    };
}
const noopRes = { status() { return this; }, json() { return this; } };

/** Let the fire-and-forget chain finish before asserting on it. */
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

async function callAuth(perms, req) {
    let passed = false;
    await perms.requireAuth(req, noopRes, () => { passed = true; });
    await settle();
    return passed;
}

test('a busy session costs one write, not one per request', async () => {
    touched.length = 0;
    const perms = loadPermissions();

    for (let i = 0; i < 25; i++) {
        assert.equal(await callAuth(perms, authedReq()), true, 'the request must pass through');
    }

    assert.deepEqual(touched, ['u1'], '25 requests inside one window are one write');
});

test('a new window stamps again — the clock keeps moving for a long session', async () => {
    touched.length = 0;
    const perms = loadPermissions({ windowSeconds: 0 });   // every request opens a new window

    await callAuth(perms, authedReq());
    await callAuth(perms, authedReq());

    assert.deepEqual(touched, ['u1', 'u1']);
});

test('each user gets their own window', async () => {
    touched.length = 0;
    fx.user = { id: 'u1', role: 'user', groups: [], organizationId: 'orgA' };
    const perms = loadPermissions();

    await callAuth(perms, authedReq('u1'));
    await callAuth(perms, authedReq('u1'));
    assert.deepEqual(touched, ['u1'], 'one throttle per account, not one globally');
});

test('an unauthenticated request never moves anybody\'s clock', async () => {
    touched.length = 0;
    const perms = loadPermissions();

    let status = 0;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    let passed = false;
    await perms.requireAuth({ session: {} }, res, () => { passed = true; });
    await settle();

    assert.equal(status, 401);
    assert.equal(passed, false);
    assert.deepEqual(touched, [], 'anonymous traffic is not activity on an account');
});

test('a session pointing at a deleted account never moves a clock', async () => {
    touched.length = 0;
    const perms = loadPermissions();

    const req = authedReq('ghost');   // getUser returns null for anything but u1
    let status = 0;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    await perms.requireAuth(req, res, () => {});
    await settle();

    assert.equal(status, 401);
    assert.deepEqual(touched, [], 'the row is gone; there is nothing to stamp');
});

test('with Redis the window holds across pods: SET … EX … NX, and the loser skips', async () => {
    touched.length = 0;
    const winner = makeFakeRedis({ nxWins: true });
    await callAuth(loadPermissions({ redis: winner }), authedReq());

    const stamp = winner.ops.find(o => o.key.startsWith('bf:lseen:'));
    assert.ok(stamp, 'the cross-pod gate is a Redis key');
    assert.equal(stamp.key, 'bf:lseen:u1');
    assert.deepEqual(stamp.args, ['1', 'EX', 900, 'NX'],
        'one atomic claim — a get-then-set would let two pods both think they won');
    assert.deepEqual(touched, ['u1']);

    touched.length = 0;
    const loser = makeFakeRedis({ nxWins: false });
    await callAuth(loadPermissions({ redis: loser }), authedReq());
    assert.deepEqual(touched, [], 'another pod already stamped this window');
});

test('the throttle key is not build-stamped — a deploy is not new activity', async () => {
    const redis = makeFakeRedis();
    process.env.APP_BUILD_SHA = 'some-build';
    try {
        await callAuth(loadPermissions({ redis }), authedReq());
    } finally {
        delete process.env.APP_BUILD_SHA;
    }
    const stamp = redis.ops.find(o => o.key.startsWith('bf:lseen:'));
    assert.equal(stamp.key, 'bf:lseen:u1',
        'unlike bf:perms:/bf:uex: this key holds no snapshot two builds could disagree about; '
        + 'stamping it would reset every window on every rolling deploy');
});

test('a failing write is swallowed: the request still passes, nothing rejects', async () => {
    touched.length = 0;
    touchThrows = 'connection terminated unexpectedly';
    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
        const perms = loadPermissions();
        assert.equal(await callAuth(perms, authedReq()), true, 'bookkeeping, not a gatekeeper');
        await settle();
    } finally {
        process.off('unhandledRejection', onRejection);
        touchThrows = null;
    }
    assert.deepEqual(rejections, [], 'a fire-and-forget write must carry its own catch');
});

test('the store facade really exports touchLastSeen, wired from ./user/users', () => {
    // The hot path calls it through require('../stores/userStore') inside a
    // promise whose .catch() swallows everything — so a missing or mis-wired
    // re-export would not be an error anywhere, just a column that silently
    // stays NULL. Requiring the real facade starts the schema init, so every
    // submodule it pulls in gets a stub (a Proxy handing back a no-op for
    // whatever property is read, so nothing has to enumerate each export) —
    // except ./user/users, whose touchLastSeen is a sentinel. That proves the
    // facade's touchLastSeen really is the one ./user/users hands back, not a
    // stand-in and not undefined.
    const { installResolveStub, evictModule } = require('../testUtils/stubRequire');
    const noop = new Proxy({}, { get: () => () => {} });
    const sentinel = () => {};
    const restore = installResolveStub({
        './user/schema': { initDB: () => {} },
        './user/users': new Proxy({}, { get: (_t, prop) => (prop === 'touchLastSeen' ? sentinel : () => {}) }),
        './user/organizations': noop,
        './user/ncBindings': noop,
        './user/groups': noop,
        './user/appPasswords': noop,
        './user/roles': noop,
        './user/plans': noop,
        './user/subscriptions': noop,
        './user/trials': noop,
        './user/audit': noop,
        './user/consent': noop,
        './user/billingLifecycle': noop,
    });
    const USERSTORE = path.join(SERVER, 'stores', 'userStore.js');
    evictModule(USERSTORE);
    try {
        const facade = require(USERSTORE);
        assert.strictEqual(facade.touchLastSeen, sentinel,
            'stores/userStore.js must re-export touchLastSeen from ./user/users, or requireAuth calls undefined into a swallowed catch');
    } finally {
        evictModule(USERSTORE);
        restore();
    }
});

test('a failing Redis is swallowed the same way', async () => {
    touched.length = 0;
    const brokenRedis = { async get() { return null; }, async set() { throw new Error('READONLY'); }, async del() { return 0; } };
    const perms = loadPermissions({ redis: brokenRedis });
    assert.equal(await callAuth(perms, authedReq()), true);
});
