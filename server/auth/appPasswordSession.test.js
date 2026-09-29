/**
 * Tests for the Nextcloud app-password endpoints' session gating.
 *
 * session.accessToken is a SHARED slot — Google/Microsoft SSO and the Google
 * Workspace connector all write to it. /app-password-status used to report
 * isNextcloudUser from token PRESENCE alone, so a Google-connected user was
 * shown Nextcloud's "auto-create from OAuth session" button, and pressing it
 * sent their GOOGLE access token as a Bearer to the org's Nextcloud host.
 *
 * Run: node --test auth/appPasswordSession.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'a'.repeat(64);

function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const state = {
    appPassword: null,
    stored: [],
    fetches: [],
    nextcloudUrl: 'https://cloud.example.com',
};

mock('../stores/userStore', {
    getAppPassword: async () => state.appPassword,
    storeAppPassword: async (...args) => { state.stored.push(args); },
    deleteAppPassword: async () => true,
});
mock('./permissions', {
    requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Unauthorized' })),
    requireAdmin: (req, res, next) => next(),
    // adminRoutes now also imports the platform-operator gate; this file's
    // subject is the app-password session, so a pass-through is fine here.
    requireSuperAdmin: (req, res, next) => next(),
    // A FACTORY, and called at module load by the org-roles route — a mock
    // without it makes the whole admin router throw on require, which reads as
    // this file's subject failing rather than as an incomplete stub.
    requirePrimaryOrgAdmin: () => (req, res, next) => next(),
    loadConfig: async () => ({ oauth: { nextcloudUrl: state.nextcloudUrl } }),
    saveConfig: async () => {},
    getUserPermissions: async () => [],
    SYSTEM_PERMISSIONS: {},
    invalidatePermissionCache: () => {},
    invalidateAllPermissionCaches: () => {},
    resolveUserOrgIds: async () => [],
    isOrgAdminRole: () => false,
});
// Records every outbound call so a token leak is directly observable.
mock('../integrations/nextcloudTarget', {
    assertAllowedNextcloudHost: () => {},
    MAX_URL_LENGTH: 512,
    nextcloudFetch: async (url, opts = {}) => {
        state.fetches.push({ url, authorization: opts.headers?.Authorization });
        return {
            ok: true,
            status: 200,
            json: async () => ({ ocs: { data: { apppassword: 'nc-generated-pw' } } }),
            text: async () => '',
        };
    },
});

const router = require('./adminRoutes');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.session = JSON.parse(req.headers['x-session'] || '{}');
    req.session.save = () => {};
    next();
});
app.use('/auth', router);

let server, base;
async function http(method, path, session) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-session': JSON.stringify(session || {}) },
    });
    let json = null; try { json = await res.json(); } catch (_) { /* no body */ }
    return { status: res.status, json };
}

const NC_SESSION = { user: { id: 'u1' }, oauthProvider: 'nextcloud', accessToken: 'nc-token-abc' };
const GOOGLE_SESSION = { user: { id: 'u1' }, oauthProvider: 'google', accessToken: 'ya29.google-token-xyz' };

test.before(async () => {
    await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
test.after(() => server?.close());

test('status: a Nextcloud SSO session is reported as a Nextcloud user', async () => {
    const r = await http('GET', '/auth/app-password-status', NC_SESSION);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.isNextcloudUser, true);
});

test('status: a GOOGLE connector session is NOT a Nextcloud user', async () => {
    const r = await http('GET', '/auth/app-password-status', GOOGLE_SESSION);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.isNextcloudUser, false,
        'token presence alone must not imply Nextcloud — this is what surfaced the auto-create button');
});

test('create-app-password: refuses a Google session and sends nothing', async () => {
    state.fetches = [];
    const r = await http('POST', '/auth/create-app-password', GOOGLE_SESSION);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'not_a_nextcloud_session');
    assert.deepStrictEqual(state.fetches, [],
        'the Google access token must never be forwarded to the Nextcloud host');
});

test('create-app-password: a real Nextcloud session still works', async () => {
    state.fetches = [];
    state.stored = [];
    const r = await http('POST', '/auth/create-app-password', NC_SESSION);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(state.fetches.length, 1);
    assert.strictEqual(state.fetches[0].authorization, 'Bearer nc-token-abc');
    assert.strictEqual(state.stored[0][2], 'nc-generated-pw');
});

test('create-app-password: 401 without any session token', async () => {
    const r = await http('POST', '/auth/create-app-password', { user: { id: 'u1' } });
    assert.strictEqual(r.status, 401);
});
