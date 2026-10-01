/**
 * resolveMicrosoftSession: a Microsoft-only session for Outlook next to
 * whatever the caller's session is (Google SSO, Nextcloud, a routine shim).
 *
 * Pins: a Microsoft session passes through untouched; a routine session's
 * `routineProviders.microsoft` is used before the vault; otherwise the vault
 * credential; the caller's own (Google) tokens are never overwritten, and a
 * token refreshed on the shim lands in the vault.
 *
 * Run: cd server && node --test auth/microsoftSessionHydration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

let credFixture = null;
const lookups = [];
const upserts = [];

const restore = installResolveStub({
    './routineAuth': {
        getProviderAuth: async (userId, provider) => { lookups.push({ userId, provider }); return credFixture; },
    },
    '../stores/routineCredentialStore': {
        upsertCredential: async (row) => { upserts.push(row); },
    },
});

const { resolveMicrosoftSession, hydrateMicrosoftSessionFromVault } = require('./microsoftSessionHydration');

test.after(() => restore());
test.beforeEach(() => { credFixture = null; lookups.length = 0; upserts.length = 0; });

const googleSession = () => ({
    user: { id: 'u1', email: 'anna@example.com' },
    oauthProvider: 'google',
    accessToken: 'google-at',
    refreshToken: 'google-rt',
});

test('a Microsoft session is returned as it is, without a vault lookup', async () => {
    const session = { user: { id: 'u1' }, oauthProvider: 'microsoft', accessToken: 'ms-at' };
    assert.strictEqual(await resolveMicrosoftSession(session), session);
    assert.strictEqual(lookups.length, 0);
});

test('a Google session gets a Microsoft-only shim from the vault and keeps its own tokens', async () => {
    credFixture = { userId: 'u1', orgId: 'o1', accessToken: 'ms-at', refreshToken: 'ms-rt', scope: 'Mail.Send offline_access' };
    const session = googleSession();
    const shim = await resolveMicrosoftSession(session);

    assert.deepStrictEqual(lookups, [{ userId: 'u1', provider: 'microsoft' }]);
    assert.notStrictEqual(shim, session);
    assert.strictEqual(shim.oauthProvider, 'microsoft');
    assert.strictEqual(shim.oauthTokenSource, 'connector');
    assert.strictEqual(shim.accessToken, 'ms-at');
    assert.strictEqual(shim.refreshToken, 'ms-rt');
    assert.strictEqual(shim.oauthScope, 'Mail.Send offline_access');
    // The caller's session is untouched.
    assert.strictEqual(session.oauthProvider, 'google');
    assert.strictEqual(session.accessToken, 'google-at');
    assert.strictEqual(session.refreshToken, 'google-rt');
});

test('no Microsoft credential → null', async () => {
    credFixture = null;
    assert.strictEqual(await resolveMicrosoftSession(googleSession()), null);
    assert.strictEqual(await resolveMicrosoftSession({}), null, 'no user → no lookup, null');
    assert.strictEqual(await resolveMicrosoftSession(null), null);
});

test('a routine session uses routineProviders.microsoft before the vault', async () => {
    const msCred = { userId: 'u2', orgId: 'o2', accessToken: 'routine-ms-at', refreshToken: 'routine-ms-rt' };
    const routine = {
        userId: 'u2', oauthProvider: 'google', accessToken: 'g', refreshToken: 'g-rt',
        routineProviders: { google: { accessToken: 'g' }, microsoft: msCred },
    };
    const shim = await resolveMicrosoftSession(routine);
    assert.strictEqual(lookups.length, 0, 'no vault read when the routine already carries the credential');
    assert.strictEqual(shim.accessToken, 'routine-ms-at');
    assert.strictEqual(shim.userId, 'u2');
});

test('the userId argument wins for sessions without a user (routine shims)', async () => {
    credFixture = { userId: 'u3', orgId: 'o3', accessToken: 'ms-at' };
    const shim = await resolveMicrosoftSession({ oauthProvider: 'nextcloud', accessToken: 'nc' }, 'u3');
    assert.deepStrictEqual(lookups, [{ userId: 'u3', provider: 'microsoft' }]);
    assert.strictEqual(shim.accessToken, 'ms-at');
});

test('a token refreshed on the shim is written to the vault, not to the caller session', async () => {
    credFixture = { userId: 'u1', orgId: 'o1', accessToken: 'old-at', refreshToken: 'old-rt', scope: 'Mail.Send' };
    const session = googleSession();
    const shim = await resolveMicrosoftSession(session);

    // What msGraphClient.refreshAccessToken does after a 401.
    shim.accessToken = 'new-at';
    shim.refreshToken = 'new-rt';
    await shim.save();

    assert.strictEqual(upserts.length, 1);
    assert.deepStrictEqual(upserts[0], {
        userId: 'u1', orgId: 'o1', provider: 'microsoft',
        accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: null, scope: 'Mail.Send',
    });
    assert.strictEqual(credFixture.accessToken, 'new-at', 'the source credential follows (routine sessions reuse it)');
    assert.strictEqual(session.accessToken, 'google-at');
    assert.strictEqual(session.refreshToken, 'google-rt');
});

test('save() survives a vault write failure and still calls back', async () => {
    credFixture = { userId: 'u1', orgId: 'o1', accessToken: 'at' };
    const shim = await resolveMicrosoftSession(googleSession());
    const store = require('../stores/routineCredentialStore');
    const original = store.upsertCredential;
    store.upsertCredential = async () => { throw new Error('db down'); };
    try {
        let called = false;
        await shim.save(() => { called = true; });
        assert.strictEqual(called, true);
    } finally {
        store.upsertCredential = original;
    }
});

test('hydrateMicrosoftSessionFromVault still never mixes providers', async () => {
    credFixture = { accessToken: 'ms-at' };
    const session = googleSession();
    assert.strictEqual(await hydrateMicrosoftSessionFromVault(session), false);
    assert.strictEqual(session.oauthProvider, 'google');
    assert.strictEqual(session.accessToken, 'google-at');
});
