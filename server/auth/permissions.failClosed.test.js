/**
 * requireAuth verifies on a cache miss that the session's user still exists.
 * When that lookup fails it must refuse (503), not let the request through:
 * an "allow on error" here kept a deleted account signed in for as long as
 * the database was unreachable.
 *
 * Run: cd server && node --test --test-force-exit auth/permissions.failClosed.test.js
 */

process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let dbDown = false;
const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => {
            if (dbDown) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
            return id === 'alive' ? { id, role: 'user' } : null;
        },
        getAllGroups: async () => [],
        getAllRoles: async () => [],
        touchLastSeen: async () => {},
    },
    '../db': { getRedis: () => null },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const id = `mock:fail-closed:${request}`;
    MOCK_IDS[request] = id;
    require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
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

const { requireAuth } = require('./permissions');

async function call(userId) {
    const req = {
        session: { isAuthenticated: true, isAdmin: false, user: { id: userId, role: 'user' }, destroy(cb) { if (cb) cb(); } },
    };
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await requireAuth(req, res, () => { nexted = true; });
    return { res, nexted };
}

test('a user the database confirms passes', async () => {
    const { nexted } = await call('alive');
    assert.equal(nexted, true);
});

test('a user the database no longer has is signed out', async () => {
    const { res, nexted } = await call('gone');
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
});

test('a database error is a 503, never a pass', async () => {
    // A fresh id, so the 5-second user-exists cache cannot answer for the DB.
    dbDown = true;
    try {
        const { res, nexted } = await call('unverifiable');
        assert.equal(nexted, false);
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'auth_unavailable' });
    } finally {
        dbDown = false;
    }
});
