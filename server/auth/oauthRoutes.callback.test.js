/**
 * SSO callback: CSRF state validation + org-membership detection.
 *
 * Two regressions are pinned here, both in GET /auth/callback/:provider.
 *
 * 1. The state check used to be a bare `state !== req.session.oauthState`,
 *    which is TRUE-for-equal when both sides are `undefined` — i.e. a callback
 *    carrying an attacker-minted authorization code and no `state`, delivered
 *    to a browser that never started an OAuth login, sailed straight through
 *    to the token exchange and established the victim's session as the
 *    attacker's identity (login CSRF). The legacy /callback handler in the
 *    same file always got this right; both now share oauthStatesMatch().
 *
 * 2. Group-based org membership was read as `g.organization_id`, but the
 *    groups table column is quoted camelCase "organizationId", so the group
 *    path never matched. A member whose ONLY org link is a group (blank
 *    users.organizationId — the shape azureGroupSync produces) was treated as
 *    org-less and silently re-bound into whichever org owns their email
 *    domain, or shown the "No Organisation Found" gate on every login.
 *
 * Run: cd server && node --test auth/oauthRoutes.callback.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { installResolveStub } = require('../testUtils/stubRequire');

// Node's relative-resolve fast path (Module._load) is keyed by the PARENT
// DIRECTORY plus the request string, and it short-circuits _resolveFilename —
// which is what installResolveStub patches. permissions.js lives in this same
// directory and pulls in ../stores/userStore & friends, so by the time
// oauthRoutes.js asks for them the fast path would hand back the real modules
// and the stubs would silently no-op. Resolving the real paths up-front and
// evicting them from require.cache after the stubs are installed invalidates
// that fast-path entry, so every request below goes through the patched
// resolver. (Resolve BEFORE installing — require.resolve is patched too.)
const STUBBED = [
    './permissions', './ssoUserResolver', '../stores/userStore', './encryption',
    './establishSession', '../integrations/azureGroupSync', '../stores/automationCredentialStore',
    '../utils/freeEmailDomains', './signupGuards', '../stores/encryptionAvailability',
];
const realPaths = STUBBED.map((r) => { try { return require.resolve(r); } catch (_) { return null; } });

// installResolveStub matches the require string AS WRITTEN inside the module
// doing the requiring. The OAuth routers now live one level deeper
// (auth/oauth/*.js), so every specifier gains a '..' — but auth/-level modules
// they pull in (accountProvisioning, permissions) still write the shorter
// form, so BOTH spellings must map to the same double.
const DEEPER = {
    './permissions': '../permissions',
    './ssoUserResolver': '../ssoUserResolver',
    '../stores/userStore': '../../stores/userStore',
    './encryption': '../encryption',
    './establishSession': '../establishSession',
    '../integrations/azureGroupSync': '../../integrations/azureGroupSync',
    '../stores/automationCredentialStore': '../../stores/automationCredentialStore',
    '../utils/freeEmailDomains': '../../utils/freeEmailDomains',
    './signupGuards': '../signupGuards',
    '../stores/encryptionAvailability': '../../stores/encryptionAvailability',
};
/** Same stub under the auth/-level key and the auth/oauth/-level key. */
const bothDepths = (map) => {
    const out = {};
    for (const [request, stub] of Object.entries(map)) {
        out[request] = stub;
        if (DEEPER[request]) out[DEEPER[request]] = stub;
    }
    return out;
};

// ── Doubles ────────────────────────────────────────────────────────
// Mutated per test; the router is required once, after the stubs are in place.
const state = {
    tokenFetches: [],
    users: new Map(),
    groups: [],
    orgs: [],
    updateCalls: [],
};

function resetState() {
    state.tokenFetches = [];
    state.users = new Map();
    state.groups = [];
    state.orgs = [];
    state.updateCalls = [];
}

const realPermissions = require('./permissions');
const realResolver = require('./ssoUserResolver');

const userStoreStub = {
    getUser: async (id) => state.users.get(id) || null,
    getAllGroups: async () => state.groups,
    getAllOrganizations: async () => state.orgs,
    updateUser: async (id, updates) => { state.updateCalls.push({ id, updates }); return true; },
    getUserByEmail: async () => null,
    getUserByAzureId: async () => null,
    getAppPassword: async () => null,
    claimNotification: async () => false,
    createUserWithSeatCheck: async () => ({ created: false, reason: 'not used in these tests' }),
    SeatCapExceededError: class SeatCapExceededError extends Error { },
};

const restore = installResolveStub(bothDepths({
    './permissions': {
        ...realPermissions,
        loadConfig: async () => ({ providers: { google: { clientId: 'cid', clientSecret: 'sec' } } }),
    },
    './ssoUserResolver': {
        ...realResolver,
        // The router's own resolution is not under test here; hand back the
        // fixture row directly so each test controls the stored shape.
        resolveExistingSSOUser: async ({ localId }) => ({
            user: state.users.get(localId) || null,
            branch: 'id',
        }),
    },
    '../stores/userStore': userStoreStub,
    './encryption': {
        getOrCreateSSOUserDEKCompat: async () => ({}),
        setupSSOUserDEK: async () => ({}),
        unlockSSOUserDEK: async () => ({}),
    },
    './establishSession': { establishSession: async () => { } },
    '../integrations/azureGroupSync': { syncUserGroupsOnLogin: async () => { } },
    '../stores/automationCredentialStore': { upsertCredential: async () => { }, listCredentials: async () => [] },
    '../utils/freeEmailDomains': { getEffectiveFreeEmailDomains: async () => ['gmail.com'] },
    './signupGuards': { checkWebSignupAllowed: async () => ({ ok: true }), resolveSignupLocale: async () => 'en' },
    '../stores/encryptionAvailability': { isEncryptionEnabledForUser: async () => false },
}));

for (const p of realPaths) if (p) delete require.cache[p];

const router = require('./oauthRoutes');

// The client needs the real fetch; the router must see the stub.
const realFetch = global.fetch;
global.fetch = async (url) => {
    const href = String(url);
    state.tokenFetches.push(href);
    if (href.includes('/token')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), text: async () => '' };
    }
    // userinfo
    return {
        ok: true, status: 200, statusText: 'OK', text: async () => '',
        json: async () => ({ sub: 'group-only@acme.example', email: 'group-only@acme.example', name: 'Group Only' }),
    };
};

// One app; each request supplies its own session object.
let nextSession = null;
const app = express();
app.use((req, res, next) => {
    req.session = nextSession || {};
    req.session.save = (cb) => { if (cb) cb(); };
    next();
});
app.use('/auth', router);

let server;
let baseUrl;

test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server && server.close();
    global.fetch = realFetch;
    restore();
});

// ── 1. CSRF state ─────────────────────────────────────────────────

test('callback with NO state and NO session state is rejected before the token exchange', async () => {
    resetState();
    nextSession = {};
    const res = await realFetch(`${baseUrl}/auth/callback/google?code=ATTACKER_CODE`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.get('location'), /error=invalid_state/);
    assert.deepStrictEqual(state.tokenFetches, [], 'the authorization code must never be exchanged');
});

test('callback with a state but no session state is rejected', async () => {
    resetState();
    nextSession = {};
    const res = await realFetch(`${baseUrl}/auth/callback/google?code=C&state=abc`, { redirect: 'manual' });
    assert.match(res.headers.get('location'), /error=invalid_state/);
    assert.deepStrictEqual(state.tokenFetches, []);
});

test('callback with a session state but no query state is rejected', async () => {
    resetState();
    nextSession = { oauthState: 'abc' };
    const res = await realFetch(`${baseUrl}/auth/callback/google?code=C`, { redirect: 'manual' });
    assert.match(res.headers.get('location'), /error=invalid_state/);
    assert.deepStrictEqual(state.tokenFetches, []);
});

test('a mismatching state is rejected and the stored state is consumed either way', async () => {
    resetState();
    const session = { oauthState: 'expected-state' };
    nextSession = session;
    const res = await realFetch(`${baseUrl}/auth/callback/google?code=C&state=wrong-state`, { redirect: 'manual' });
    assert.match(res.headers.get('location'), /error=invalid_state/);
    assert.deepStrictEqual(state.tokenFetches, []);
    assert.strictEqual(session.oauthState, undefined, 'a leaked state must not be replayable');
});

test('a matching state still passes — the guard must not lock legitimate logins out', async () => {
    resetState();
    state.users.set('group-only@acme.example', {
        id: 'group-only@acme.example', email: 'group-only@acme.example',
        groups: [], organizationId: 'acme', orgRole: 'member', status: 'active',
    });
    nextSession = { oauthState: 'good-state' };
    await realFetch(`${baseUrl}/auth/callback/google?code=C&state=good-state`, { redirect: 'manual' });
    assert.ok(
        state.tokenFetches.some((u) => u.includes('/token')),
        'the token exchange must run for a correctly-stated callback',
    );
});

// ── 2. Group-only org membership ──────────────────────────────────

test('a member whose only org link is a group is NOT re-bound by email domain', async () => {
    resetState();
    const uid = 'group-only@acme.example';
    // Exactly the azureGroupSync shape: blank organizationId + blank orgRole,
    // membership carried solely by the group row.
    state.users.set(uid, {
        id: uid, email: uid, groups: ['grp-acme'],
        organizationId: '', orgRole: '', status: 'active',
    });
    state.groups = [{ id: 'grp-acme', organizationId: 'org-acme', name: 'Acme staff' }];
    // A DIFFERENT org owns the email domain — the rebind target.
    state.orgs = [{ id: 'org-other', name: 'Other BV', allowedDomains: ['acme.example'], autoApproveSSO: false }];

    const session = { oauthState: 's' };
    nextSession = session;
    await realFetch(`${baseUrl}/auth/callback/google?code=C&state=s`, { redirect: 'manual' });

    const rebinds = state.updateCalls.filter((c) => c.updates.organizationId !== undefined);
    assert.deepStrictEqual(rebinds, [], 'must not overwrite organizationId/orgRole/status of a group-only member');
    assert.notStrictEqual(session.noOrganization, true, 'must not show the "No Organisation Found" gate');
    assert.notStrictEqual(session.pendingApproval, true, 'must not flip an active member to pending');
});

test('a group with no org still counts as org-less (domain match may proceed)', async () => {
    resetState();
    const uid = 'group-only@acme.example';
    state.users.set(uid, {
        id: uid, email: uid, groups: ['grp-global'],
        organizationId: '', orgRole: '', status: 'active',
    });
    // A global group carries organizationId NULL — not an org membership.
    state.groups = [{ id: 'grp-global', organizationId: null, name: 'Everyone' }];
    state.orgs = [{ id: 'org-other', name: 'Other BV', allowedDomains: ['acme.example'], autoApproveSSO: true }];

    nextSession = { oauthState: 's' };
    await realFetch(`${baseUrl}/auth/callback/google?code=C&state=s`, { redirect: 'manual' });

    const rebinds = state.updateCalls.filter((c) => c.updates.organizationId !== undefined);
    assert.strictEqual(rebinds.length, 1, 'a genuinely org-less user is still domain-matched');
    assert.strictEqual(rebinds[0].updates.organizationId, 'org-other');
});
