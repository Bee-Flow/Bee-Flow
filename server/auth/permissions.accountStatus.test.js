/**
 * requireAuth asks the account-status gate on every request, not only at
 * sign-in: an account that may no longer start a session may no longer keep
 * one (auth/accountStatusGate.js). Before, a suspended account kept its cookie
 * working until it expired.
 *
 * Run: cd server && node --test auth/permissions.accountStatus.test.js
 */

process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const ROWS = {
    active: { id: 'active', role: 'user', status: 'active' },
    legacy: { id: 'legacy', role: 'user' },                       // from before the column: active
    suspended: { id: 'suspended', role: 'user', status: 'suspended' },
    'suspended-admin': { id: 'suspended-admin', role: 'admin', status: 'suspended' },
};
const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => ROWS[id] || null,
        getAllGroups: async () => [],
        getAllRoles: async () => [],
        touchLastSeen: async () => {},
    },
    '../db': { getRedis: () => null },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const id = `mock:account-status:${request}`;
    MOCK_IDS[request] = id;
    require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/](permissions\w*|orgScope)\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
after(() => { Module._resolveFilename = originalResolve; });

const { requireAuth } = require('./permissions');

async function call(userId, isAdmin = false) {
    let destroyed = false;
    const req = {
        session: { isAuthenticated: true, isAdmin, user: { id: userId, role: isAdmin ? 'admin' : 'user' }, destroy(cb) { destroyed = true; if (cb) cb(); } },
    };
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await requireAuth(req, res, () => { nexted = true; });
    return { res, nexted, destroyed };
}

test('an active account passes, and so does a row from before the status column', async () => {
    assert.equal((await call('active')).nexted, true);
    assert.equal((await call('legacy')).nexted, true);
});

test('a suspended account is signed out on its next request', async () => {
    const { res, nexted, destroyed } = await call('suspended');
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
    assert.equal(destroyed, true, 'the session goes with it');
    assert.deepEqual(res.body, { error: 'Not authenticated' }, 'the same answer as any other refusal');
});

test('a suspended platform admin is no exception', async () => {
    const { res, nexted } = await call('suspended-admin', true);
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
});

// ── Held for approval ────────────────────────────────────────────────────
//
// The waiting screen was the only thing between a held account and the API.
// Held means the sign-in path flagged the session AND the row still waits.

ROWS.held = { id: 'held', role: 'user', status: 'pending' };
ROWS.waitlisted = { id: 'waitlisted', role: 'user', status: 'waitlist' };
ROWS.founder = { id: 'founder', role: 'user', status: 'pending', orgRole: 'org_admin' };
ROWS.approved = { id: 'approved', role: 'user', status: 'active' };

async function callAt(userId, url, flagged) {
    const req = {
        originalUrl: url, url,
        session: { isAuthenticated: true, isAdmin: false, user: { id: userId, role: 'user' }, ...(flagged ? { pendingApproval: true } : {}), destroy(cb) { if (cb) cb(); } },
    };
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await requireAuth(req, res, () => { nexted = true; });
    return { res, nexted };
}

test('a held account may read who it is and sign out, and nothing else', async () => {
    for (const id of ['held', 'waitlisted']) {
        for (const url of ['/auth/user', '/auth/my-permissions?x=1', '/auth/logout', '/auth/setup-status']) {
            assert.equal((await callAt(id, url, true)).nexted, true, `${id} ${url}`);
        }
        const { res, nexted } = await callAt(id, '/api/agents', true);
        assert.equal(nexted, false, id);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, 'pending_approval');
    }
});

test('a founder let past approval (no flag on the session) is not held', async () => {
    assert.equal((await callAt('founder', '/api/agents', false)).nexted, true);
});

test('an account approved since it signed in goes through, flag or no flag', async () => {
    assert.equal((await callAt('approved', '/api/agents', true)).nexted, true);
});
