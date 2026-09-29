/**
 * Revoking a vaulted provider credential (auth/oauth/credentialRoutes.js).
 *
 * The vault keeps a refresh token and an access token that lives an hour and
 * is only refreshed when a routine runs. Revocation sent Google the ACCESS
 * token — by the time somebody disconnects, usually an expired one, which
 * Google answers with `invalid_token` and revokes nothing. The grant stayed on
 * the person's Google account after "disconnect". Google revokes the whole
 * grant when handed the refresh token, so that is what goes now.
 *
 * Run: cd server && node --test auth/oauth/credentialRoutes.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = { cred: null, deleted: [], audits: [] };

const MOCKS = {
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../../stores/routineCredentialStore': {
        listProvidersForUser: async () => [],
        getCredential: async () => fx.cred,
        markRevoked: async () => {},
        deleteCredential: async (userId, provider) => { fx.deleted.push(provider); return true; },
    },
    '../../stores/userStore': {
        logAccessAudit: async (...a) => { fx.audits.push(a); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:credential-routes:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /oauth[\\/]credentialRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./credentialRoutes');
const { revokeProviderCredential } = router;

// Google's revocation endpoint, as this module calls it.
const sent = [];
const originalFetch = global.fetch;
global.fetch = async (url, init) => {
    sent.push({ url, token: new URLSearchParams(init.body).get('token') });
    return { ok: true, status: 200 };
};
test.after(() => {
    Module._resolveFilename = originalResolve;
    global.fetch = originalFetch;
});

const HOUR_AGO = Date.now() - 60 * 60 * 1000;

test.beforeEach(() => {
    sent.length = 0;
    fx.deleted.length = 0;
    fx.audits.length = 0;
    fx.cred = null;
});

test('Google is handed the refresh token, which ends the grant — not an access token that expired', async () => {
    fx.cred = { orgId: 'org1', accessToken: 'ya29.expired', refreshToken: '1//refresh', expiresAt: HOUR_AGO };
    const result = await revokeProviderCredential('u1', 'google');
    assert.deepStrictEqual(sent, [{ url: 'https://oauth2.googleapis.com/revoke', token: '1//refresh' }]);
    assert.strictEqual(result.providerRevokeAttempted, true);
    assert.deepStrictEqual(fx.deleted, ['google'], 'the vault row goes either way');
});

test('a Google credential with no refresh token still revokes its access token', async () => {
    fx.cred = { orgId: 'org1', accessToken: 'ya29.live', refreshToken: null, expiresAt: Date.now() + 60_000 };
    await revokeProviderCredential('u1', 'google');
    assert.deepStrictEqual(sent.map((s) => s.token), ['ya29.live']);
});

test('a Google credential holding only a refresh token is revoked, not skipped as "no token"', async () => {
    fx.cred = { orgId: 'org1', accessToken: null, refreshToken: '1//refresh' };
    const result = await revokeProviderCredential('u1', 'google');
    assert.deepStrictEqual(sent.map((s) => s.token), ['1//refresh']);
    assert.strictEqual(result.providerRevokeAttempted, true);
});

test('providers without a revocation endpoint are unchanged: nothing is sent, the row still goes', async () => {
    fx.cred = { orgId: 'org1', accessToken: 'eyJ.ms', refreshToken: 'ms-refresh' };
    const result = await revokeProviderCredential('u1', 'microsoft');
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(result.providerRevokeOk, false);
    assert.deepStrictEqual(fx.deleted, ['microsoft']);
});

test('an unknown credential is not found, and nothing is sent anywhere', async () => {
    const result = await revokeProviderCredential('u1', 'google');
    assert.deepStrictEqual(result, { found: false });
    assert.deepStrictEqual(sent, []);
});
