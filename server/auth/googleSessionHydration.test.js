/**
 * BFSF-255 — vault → session hydration rules.
 *
 * Pins: hydration only when the session has NO OAuth identity (never mixes
 * providers), the 'connector' tag (forced-MFA gate must not treat it as SSO),
 * and graceful no-ops for anonymous sessions / missing credentials.
 *
 * Run: cd server && node --test auth/googleSessionHydration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

let credFixture = null;

const mockId = 'mock:hydration:./automationAuth';
require.cache[mockId] = {
    id: mockId, filename: mockId, loaded: true,
    exports: { getProviderAuth: async () => credFixture },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]googleSessionHydration\.js$/.test(parent.filename) && request === './automationAuth') {
        return mockId;
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { hydrateGoogleSessionFromVault } = require('./googleSessionHydration');

test.after(() => { Module._resolveFilename = originalResolve; });

test('hydrates a provider-less session and tags it connector', async () => {
    credFixture = { accessToken: 'at', refreshToken: 'rt' };
    const session = { user: { id: 'u1' }, save(cb) { cb(); } };
    assert.strictEqual(await hydrateGoogleSessionFromVault(session), true);
    assert.strictEqual(session.oauthProvider, 'google');
    assert.strictEqual(session.oauthTokenSource, 'connector');
    assert.strictEqual(session.accessToken, 'at');
});

test('never touches a session that already has an OAuth identity', async () => {
    credFixture = { accessToken: 'at' };
    const session = { user: { id: 'u1' }, oauthProvider: 'microsoft', accessToken: 'ms' };
    assert.strictEqual(await hydrateGoogleSessionFromVault(session), false);
    assert.strictEqual(session.oauthProvider, 'microsoft');
    assert.strictEqual(session.accessToken, 'ms');
});

test('no credential / anonymous session → no-op', async () => {
    credFixture = null;
    const session = { user: { id: 'u1' } };
    assert.strictEqual(await hydrateGoogleSessionFromVault(session), false);
    assert.strictEqual(session.oauthProvider, undefined);

    credFixture = { accessToken: 'at' };
    assert.strictEqual(await hydrateGoogleSessionFromVault({}), false, 'no user id → no-op');
    assert.strictEqual(await hydrateGoogleSessionFromVault(null), false);
});
