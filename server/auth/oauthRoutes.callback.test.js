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
    './microsoftIdentity', '../stores/microsoftIdentityStore',
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
    './microsoftIdentity': '../microsoftIdentity',
    '../stores/microsoftIdentityStore': '../../stores/microsoftIdentityStore',
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
    state.linkRequests = []; state.sessions = []; state.graphOid = null; state.verifyError = null; state.msTenant = 'common';
    state.identity = { azureTenantId: '11111111-1111-1111-1111-111111111111', azureUserId: '22222222-2222-2222-2222-222222222222' };
}

const realPermissions = require('./permissions');
const realResolver = require('./ssoUserResolver');
const realMicrosoftIdentity = require('./microsoftIdentity');

const userStoreStub = {
    getUser: async (id) => state.users.get(id) || null,
    getAllGroups: async () => state.groups,
    getAllOrganizations: async () => state.orgs,
    updateUser: async (id, updates) => { state.updateCalls.push({ id, updates }); return true; },
    getUserByEmail: async email => [...state.users.values()].find(user => user.email?.toLowerCase() === email.toLowerCase()) || null,
    getUserByAzureId: async (oid, tid) => [...state.users.values()].find(user => user.azureUserId === oid && user.azureTenantId === tid) || null,
    getAppPassword: async () => null,
    claimNotification: async () => false,
    createUserWithSeatCheck: async () => ({ created: false, reason: 'not used in these tests' }),
    SeatCapExceededError: class SeatCapExceededError extends Error { },
};

const restore = installResolveStub(bothDepths({
    './permissions': {
        ...realPermissions,
        loadConfig: async () => ({ providers: { google: { clientId: 'cid', clientSecret: 'sec' }, microsoft: { clientId: 'cid', clientSecret: 'sec', tenantId: state.msTenant } } }),
    },
    './ssoUserResolver': {
        ...realResolver,
        // The router's own resolution is not under test here; hand back the
        // fixture row directly so each test controls the stored shape.
        resolveExistingSSOUser: async identity => identity.azureUserId ? realResolver.resolveExistingSSOUser(identity, userStoreStub) : ({ user: state.users.get(identity.localId) || null, branch: 'id' }),
    },
    '../stores/userStore': userStoreStub,
    './encryption': {
        getOrCreateSSOUserDEKCompat: async () => ({}),
        setupSSOUserDEK: async () => ({}),
        unlockSSOUserDEK: async () => ({}),
    },
    './establishSession': { establishSession: async (req) => { state.sessions.push(req.session.user); } },
    './microsoftIdentity': { ...realMicrosoftIdentity, verifyMicrosoftIdentity: async () => { if (state.verifyError) throw state.verifyError; return state.identity; } },
    '../stores/microsoftIdentityStore': { findUnboundIdentity: async oid => [...state.users.values()].filter(user => user.azureUserId === oid && !user.azureTenantId), requestLink: async request => state.linkRequests.push(request),
        // Mirrors the unambiguous-oid rule of the real store (covered by its pg test).
        autoLinkLegacy: async ({ azureTenantId, azureUserId, configuredTenantId }) => {
            const owners = [...state.users.values()].filter(user => user.azureUserId === azureUserId);
            if (configuredTenantId !== azureTenantId || owners.length !== 1 || owners[0].azureTenantId) return { linked: false, reason: 'x' };
            owners[0].azureTenantId = azureTenantId; return { linked: true, userId: owners[0].id, basis: 'auto-link-oid' };
        },
        getIdentityBinding: async id => state.users.has(id) ? { ...state.identity, revision: '0' } : null },
    '../integrations/azureGroupSync': { syncUserGroupsOnLogin: async () => { } },
    '../stores/automationCredentialStore': { upsertCredential: async () => { }, listCredentials: async () => [] },
    '../utils/freeEmailDomains': { getEffectiveFreeEmailDomains: async () => ['gmail.com'] },
    './signupGuards': { checkWebSignupAllowed: async () => ({ ok: true }), resolveSignupLocale: async () => 'en' },
    '../stores/encryptionAvailability': { isEncryptionEnabledForUser: async () => false, isSsoPinRequiredForUser: async () => false },
}));

for (const p of realPaths) if (p) delete require.cache[p];

const router = require('./oauthRoutes');

// The client needs the real fetch; the router must see the stub.
const realFetch = global.fetch;
global.fetch = async (url) => {
    const href = String(url);
    state.tokenFetches.push(href);
    if (href.includes('/token')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'validated-by-the-identity-test-double' }), text: async () => '' };
    }
    if (href.includes('graph.microsoft.com')) {
        if (href.includes('/photo/')) return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => ({ id: state.graphOid || state.identity.azureUserId, mail: 'group-only@acme.example', displayName: 'Microsoft profile' }) };
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
    nextSession = { oauthProvider: 'google', oauthState: 'abc' };
    const res = await realFetch(`${baseUrl}/auth/callback/google?code=C`, { redirect: 'manual' });
    assert.match(res.headers.get('location'), /error=invalid_state/);
    assert.deepStrictEqual(state.tokenFetches, []);
});

test('a mismatching state is rejected and the stored state is consumed either way', async () => {
    resetState();
    const session = { oauthProvider: 'google', oauthState: 'expected-state' };
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
    nextSession = { oauthProvider: 'google', oauthState: 'good-state' };
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

    const session = { oauthProvider: 'google', oauthState: 's' };
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

    nextSession = { oauthProvider: 'google', oauthState: 's' };
    await realFetch(`${baseUrl}/auth/callback/google?code=C&state=s`, { redirect: 'manual' });

    const rebinds = state.updateCalls.filter((c) => c.updates.organizationId !== undefined);
    assert.strictEqual(rebinds.length, 1, 'a genuinely org-less user is still domain-matched');
    assert.strictEqual(rebinds[0].updates.organizationId, 'org-other');
});


// Token claim/signature validation is covered with actual signed tokens in
// microsoftIdentity.test.js; these cases pin the account/session decisions.
async function microsoftCallback() {
    nextSession = { oauthProvider: 'microsoft', oauthState: 's', oauthNonce: 'nonce' };
    return realFetch(`${baseUrl}/auth/callback/microsoft?code=C&state=s`, { redirect: 'manual' });
}
test('same email with a different Microsoft object or tenant creates only a validated linking request', async () => {
    for (const identity of [{ azureTenantId: '11111111-1111-1111-1111-111111111111', azureUserId: '33333333-3333-3333-3333-333333333333' },
        { azureTenantId: '44444444-4444-4444-4444-444444444444', azureUserId: '22222222-2222-2222-2222-222222222222' }]) {
        resetState();
        state.users.set('local', { id: 'local', email: 'group-only@acme.example', azureTenantId: state.identity.azureTenantId, azureUserId: state.identity.azureUserId });
        state.identity = identity;
        const response = await microsoftCallback();
        assert.match(response.headers.get('location'), /error=sso_link_required/);
        assert.deepStrictEqual(state.linkRequests, [{ ...identity, email: 'group-only@acme.example' }]);
        assert.deepStrictEqual(state.updateCalls, []); assert.deepStrictEqual(state.sessions, []);
        assert.strictEqual(nextSession.user, undefined);
        assert.strictEqual(state.users.size, 1);
    }
});
test('unconfirmed legacy object IDs require administrator linking even when the email changed', async () => {
    resetState();
    state.users.set('legacy-local', { id: 'legacy-local', azureUserId: state.identity.azureUserId, email: 'old@example.test' });
    const response = await microsoftCallback();
    assert.match(response.headers.get('location'), /error=sso_link_required/);
    assert.strictEqual(state.linkRequests.length, 1); assert.deepStrictEqual(state.sessions, []);
});
test('a pre-upgrade account with a stored object ID signs in at once when the configured tenant is concrete', async () => {
    resetState();
    state.msTenant = state.identity.azureTenantId;
    state.users.set('legacy-local', { id: 'legacy-local', azureUserId: state.identity.azureUserId, email: 'old@example.test', groups: [], organizationId: 'org-A', status: 'active', role: 'user' });
    const response = await microsoftCallback();
    assert.doesNotMatch(response.headers.get('location') || '', /error=/);
    assert.deepStrictEqual(state.linkRequests, []);
    assert.strictEqual(nextSession.user.id, 'legacy-local');
    assert.strictEqual(state.users.get('legacy-local').azureTenantId, state.identity.azureTenantId);
});
test('rejected Microsoft tokens and mismatching Graph IDs cannot request linking or start sessions', async () => {
    for (const invalidToken of [true, false]) {
        resetState();
        if (invalidToken) state.verifyError = new Error('Invalid Microsoft ID token');
        else state.graphOid = '55555555-5555-5555-5555-555555555555';
        const response = await microsoftCallback();
        assert.match(response.headers.get('location'), /error=/);
        assert.deepStrictEqual(state.linkRequests, []); assert.deepStrictEqual(state.sessions, []);
        assert.deepStrictEqual(state.updateCalls, []); assert.strictEqual(nextSession.user, undefined);
    }
});
test('an exact Microsoft identity retains its local account without domain-based organization assignment', async () => {
    resetState();
    state.users.set('local', { id: 'local', ...state.identity, email: 'group-only@acme.example', groups: [], organizationId: '', status: 'active', role: 'user' });
    state.orgs = [{ id: 'email-domain-org', allowedDomains: ['acme.example'], autoApproveSSO: true }];
    await microsoftCallback();
    assert.strictEqual(nextSession.user.id, 'local');
    assert.strictEqual(nextSession.microsoftIdentityVersion, 2);
    assert.deepStrictEqual(nextSession.microsoftLoginIdentity, { ...state.identity, revision: '0' });
    assert.deepStrictEqual(state.updateCalls.filter(call => call.updates.organizationId !== undefined), []);
    assert.deepStrictEqual(state.linkRequests, []);
});
