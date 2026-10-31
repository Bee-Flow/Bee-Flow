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

/** Rows by id for the account-status cases at the bottom of this file. */
const ROWS = {
    active: { id: 'active', role: 'user', status: 'active' },
    legacy: { id: 'legacy', role: 'user' },                       // from before the column: active
    suspended: { id: 'suspended', role: 'user', status: 'suspended' },
    'suspended-admin': { id: 'suspended-admin', role: 'admin', status: 'suspended' },
    held: { id: 'held', role: 'user', status: 'pending' },
    waitlisted: { id: 'waitlisted', role: 'user', status: 'waitlist' },
    founder: { id: 'founder', role: 'user', status: 'pending', orgRole: 'org_admin' },
    approved: { id: 'approved', role: 'user', status: 'active' },
};

let dbDown = false;
// Fail every lookup after the first: the existence check passes, the admin re-check does not.
let failAfterFirst = false;
let lookups = 0;
const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => {
            if (dbDown || (failAfterFirst && lookups++ > 0)) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
            if (ROWS[id]) return ROWS[id];
            if (id === 'demoted') return { id, role: 'user' };
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
    if (parent && /auth[\\/](permissions\w*|orgScope)\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
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

test('an admin session whose re-check lookup fails is refused, not kept elevated', async () => {
    failAfterFirst = true; lookups = 0;
    let err;
    try {
        const req = {
            session: { isAuthenticated: true, isAdmin: true, user: { id: 'demoted', role: 'admin', isAdmin: true }, destroy(cb) { if (cb) cb(); } },
        };
        const res = { status() { return this; }, json() { return this; } };
        await requireAuth(req, res, (e) => { err = e; });
    } finally { failAfterFirst = false; }
    assert.ok(err, 'next() must receive an error, never pass the request on');
    assert.equal(err.status, 503);
    assert.equal(err.code, 'auth_unavailable');
});

test('a plain session whose re-check lookup fails carries on: it has no elevation to lose', async () => {
    failAfterFirst = true; lookups = 0;
    let nexted;
    try {
        const { nexted: n } = await call('demoted');
        nexted = n;
    } finally { failAfterFirst = false; }
    assert.equal(nexted, true);
});

test('a database error is a 503 auth_unavailable on the wire, never a pass', async () => {
    // A fresh id, so the 5-second user-exists cache cannot answer for the DB.
    const express = require('express');
    const h = require('../testUtils/routeHarness');
    let reached = false;
    const router = express.Router();
    router.use(requireAuth);
    router.get('/x', (_req, res) => { reached = true; res.json({ ok: true }); });
    const api = h.serve('/', router, { user: { id: 'unverifiable', role: 'user' } });
    dbDown = true;
    try {
        const res = await api.call('GET', '/x');
        assert.equal(res.status, 503);
        assert.equal(res.body.error, 'auth_unavailable');
        assert.equal(res.body.code, 'auth_unavailable');
        assert.ok(res.body.correlationId);
        assert.equal(reached, false);
    } finally {
        dbDown = false;
        await api.close();
    }
});

test('a Microsoft session whose identity-binding lookup throws is a 503 auth_unavailable, never a pass', async () => {
    const express = require('express');
    const h = require('../testUtils/routeHarness');
    const storePath = require.resolve('../stores/microsoftIdentityStore');
    const saved = require.cache[storePath];
    require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { getIdentityBinding: async () => { throw new Error('db down'); } } };
    let reached = false;
    const router = express.Router();
    router.use(requireAuth);
    router.get('/x', (_req, res) => { reached = true; res.json({ ok: true }); });
    const identity = { azureTenantId: '11111111-1111-1111-1111-111111111111', azureUserId: '22222222-2222-2222-2222-222222222222', revision: '4' };
    const api = h.serve('/', router, {
        user: { id: 'alive', role: 'user' },
        session: { oauthProvider: 'microsoft', microsoftIdentityVersion: 2, microsoftLoginIdentity: identity },
    });
    try {
        const res = await api.call('GET', '/x');
        assert.equal(res.status, 503);
        assert.equal(res.body.error, 'auth_unavailable');
        assert.equal(reached, false);
    } finally {
        if (saved) require.cache[storePath] = saved; else delete require.cache[storePath];
        await api.close();
    }
});

// ── The account-status gate, asked on every request ──────────────────────
//
// An account that may no longer start a session may no longer keep one
// (auth/accountStatusGate.js): a suspended account is signed out on its next
// request; a session held for approval reaches its waiting screen's calls only.

async function callAs(userId, isAdmin = false) {
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
    assert.equal((await callAs('active')).nexted, true);
    assert.equal((await callAs('legacy')).nexted, true);
});

test('a suspended account is signed out on its next request', async () => {
    const { res, nexted, destroyed } = await callAs('suspended');
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
    assert.equal(destroyed, true, 'the session goes with it');
    assert.deepEqual(res.body, { error: 'Not authenticated' }, 'the same answer as any other refusal');
});

test('a suspended platform admin is no exception', async () => {
    const { res, nexted } = await callAs('suspended-admin', true);
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
});

// ── Held for approval ────────────────────────────────────────────────────
//
// The waiting screen was the only thing between a held account and the API.
// Held means the sign-in path flagged the session AND the row still waits.


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
