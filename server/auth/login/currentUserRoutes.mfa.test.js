/**
 * `mfaSetupRequired` on GET /auth/user — the A3 read side, behaviourally.
 *
 * The derivation was previously pinned nowhere (this dir had no tests until
 * this release). What must hold, per the two-release rule for the org-MFA
 * duty:
 *   - the platform flag keeps its missing⇒ON default (unchanged behaviour);
 *   - the org flag `org_mfa_required_<orgId>` is OR'd in: it can only ADD the
 *     duty, and a MISSING org row adds nothing (default-off — never `?? true`);
 *   - the SSO exemption survives the org duty (an IdP-owned login is never
 *     forced into local TOTP), while a connector-hydrated session stays
 *     NON-exempt (BFSF-255);
 *   - enrolment, admin and password-account branches behave as before;
 *   - an org-flag read failure degrades to "no extra duty" and never breaks
 *     the /auth/user payload.
 *
 * Mock seams mirror routes/orgAiContext.test.js: configStore/userStore/
 * permissions stubs behind Module._resolveFilename; the org-flag module
 * itself is REAL (its normalize + memo are part of what is under test).
 *
 * Run: cd server && node --test --test-force-exit auth/login/currentUserRoutes.mfa.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const http = require('http');

// ── In-memory stubs ────────────────────────────────────────────────────────
const blobs = {};                 // config key → value
let throwOnOrgFlagRead = false;
let currentFreshUser = null;

const configStoreStub = {
    async getConfig(key) {
        if (key.startsWith('org_mfa_required_') && throwOnOrgFlagRead) throw new Error('store down');
        return blobs[key] !== undefined ? blobs[key] : null;
    },
};
const userStoreStub = {
    async getUser() { return currentFreshUser; },
    async getOrganization(orgId) { return orgId ? { id: orgId, name: 'Org' } : null; },
    async getPendingNcBindingForOrg() { return null; },
};
const permissionsStub = {
    async loadConfig() { return { oauth: { clientId: null, clientSecret: null, providers: [] } }; },
};
const consentGuardsStub = { auditClientIp: () => null };
const encryptionStub = { isEncryptionEnabledForUser: async () => false };

const ENTITLEMENTS = path.sep + path.join('core', 'entitlements') + path.sep;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename ? parent.filename : '';
    if (from.endsWith(path.join('auth', 'login', 'currentUserRoutes.js'))) {
        if (request === '../../stores/configStore') return path.join(__dirname, '__stub_cfg_mfa__.js');
        if (request === '../../stores/userStore') return path.join(__dirname, '__stub_users_mfa__.js');
        if (request === '../permissions') return path.join(__dirname, '__stub_perm_mfa__.js');
        if (request === '../consentGuards') return path.join(__dirname, '__stub_consent_mfa__.js');
        if (request === '../../stores/encryptionAvailability') return path.join(__dirname, '__stub_enc_mfa__.js');
    }
    if (from.includes(ENTITLEMENTS) && request === '../../stores/configStore') {
        return path.join(__dirname, '__stub_cfg_mfa__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
for (const [fname, exp] of Object.entries({
    '__stub_cfg_mfa__.js': configStoreStub,
    '__stub_users_mfa__.js': userStoreStub,
    '__stub_perm_mfa__.js': permissionsStub,
    '__stub_consent_mfa__.js': consentGuardsStub,
    '__stub_enc_mfa__.js': encryptionStub,
})) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

const { invalidateOrgMfaRequired } = require('../../core/entitlements/orgMfaRequired');
const express = require('express');
const router = require('./currentUserRoutes');
const app = express();
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/auth', router);
let server;

before(() => { server = app.listen(0); });
after(() => { server?.close(); Module._resolveFilename = origResolve; });

function getUser() {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/auth/user`, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        }).on('error', reject);
    });
}

let orgSeq = 0;
function freshOrg() { return `org_mfa_case_${++orgSeq}`; }

function makeUser(orgId, overrides = {}) {
    return {
        id: 'u1', displayName: 'U', email: 'u@example.test', role: 'user',
        organizationId: orgId, orgRole: 'member', provider: 'local',
        passwordHash: 'hash', mfa_enabled: false, avatar: null,
        ...overrides,
    };
}
function makeSession(overrides = {}) {
    return { isAuthenticated: true, isAdmin: false, user: { id: 'u1' }, ...overrides };
}

beforeEach(() => {
    for (const k of Object.keys(blobs)) delete blobs[k];
    throwOnOrgFlagRead = false;
});

test('platform flag missing still defaults ON — behaviour before this release, unchanged', async () => {
    const org = freshOrg();
    currentFreshUser = makeUser(org);
    currentSession = makeSession();
    const res = await getUser();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mfaSetupRequired, true);
});

test('platform off + org flag MISSING ⇒ not required (the org flag defaults off, never `?? true`)', async () => {
    const org = freshOrg();
    blobs['require_mfa_for_password_accounts'] = false;
    currentFreshUser = makeUser(org);
    currentSession = makeSession();
    assert.strictEqual((await getUser()).body.mfaSetupRequired, false,
        'an org that never configured the duty must behave exactly as today');
});

test('platform off + org duty ON ⇒ required — the OR adds the duty', async () => {
    const org = freshOrg();
    blobs['require_mfa_for_password_accounts'] = false;
    blobs[`org_mfa_required_${org}`] = { required: true };
    currentFreshUser = makeUser(org);
    currentSession = makeSession();
    assert.strictEqual((await getUser()).body.mfaSetupRequired, true);
});

test('org duty ON cannot be dodged by the platform flag being off, but SSO stays exempt', async () => {
    const org = freshOrg();
    blobs['require_mfa_for_password_accounts'] = false;
    blobs[`org_mfa_required_${org}`] = { required: true };
    // SSO via session (IdP login)
    currentFreshUser = makeUser(org);
    currentSession = makeSession({ oauthProvider: 'google', oauthTokenSource: 'login' });
    assert.strictEqual((await getUser()).body.mfaSetupRequired, false,
        'the IdP owns MFA — the org duty must not force local TOTP onto SSO logins');
    // SSO via the users row
    invalidateOrgMfaRequired(org);
    currentFreshUser = makeUser(org, { provider: 'google', passwordHash: null });
    currentSession = makeSession();
    assert.strictEqual((await getUser()).body.mfaSetupRequired, false);
});

test('a connector-hydrated session is NOT SSO — the org duty still applies (BFSF-255)', async () => {
    const org = freshOrg();
    blobs['require_mfa_for_password_accounts'] = false;
    blobs[`org_mfa_required_${org}`] = { required: true };
    currentFreshUser = makeUser(org);
    currentSession = makeSession({ oauthProvider: 'google', oauthTokenSource: 'connector' });
    assert.strictEqual((await getUser()).body.mfaSetupRequired, true,
        'connecting Google in Settings must never exempt a password account');
});

test('already-enrolled users are done, org duty or not', async () => {
    const org = freshOrg();
    blobs['require_mfa_for_password_accounts'] = false;
    blobs[`org_mfa_required_${org}`] = { required: true };
    currentFreshUser = makeUser(org, { mfa_enabled: true });
    currentSession = makeSession();
    assert.strictEqual((await getUser()).body.mfaSetupRequired, false);
});

test('admins are included; passwordless non-admin accounts are not', async () => {
    const org = freshOrg();
    blobs['require_mfa_for_password_accounts'] = false;
    blobs[`org_mfa_required_${org}`] = { required: true };
    currentFreshUser = makeUser(org, { passwordHash: null });
    currentSession = makeSession({ isAdmin: true });
    assert.strictEqual((await getUser()).body.mfaSetupRequired, true, 'the built-in admin may predate its users row');

    invalidateOrgMfaRequired(org);
    currentSession = makeSession();
    assert.strictEqual((await getUser()).body.mfaSetupRequired, false, 'nothing to enrol without a password');
});

test('a malformed org row adds no duty', async () => {
    const org = freshOrg();
    blobs['require_mfa_for_password_accounts'] = false;
    blobs[`org_mfa_required_${org}`] = { required: 'yes' };
    currentFreshUser = makeUser(org);
    currentSession = makeSession();
    assert.strictEqual((await getUser()).body.mfaSetupRequired, false);
});

test('an org-flag read failure degrades to "no extra duty" and /auth/user still answers', async () => {
    const org = freshOrg();
    blobs['require_mfa_for_password_accounts'] = false;
    throwOnOrgFlagRead = true;
    currentFreshUser = makeUser(org);
    currentSession = makeSession();
    const res = await getUser();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mfaSetupRequired, false,
        'the platform flag (missing⇒ON) is the backstop; a failing org read must not throw into the payload');
});

test('but the failure cannot weaken the platform duty — platform ON + broken org read stays required', async () => {
    const org = freshOrg();
    throwOnOrgFlagRead = true; // platform key still readable (missing ⇒ ON)
    currentFreshUser = makeUser(org);
    currentSession = makeSession();
    assert.strictEqual((await getUser()).body.mfaSetupRequired, true);
});

test('consumer accounts (no org) see only the platform flag', async () => {
    blobs['require_mfa_for_password_accounts'] = false;
    currentFreshUser = makeUser('', { organizationId: '' });
    currentSession = makeSession();
    assert.strictEqual((await getUser()).body.mfaSetupRequired, false);
});
