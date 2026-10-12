/**
 * DB-free unit test for createGoogleApiClient (M3).
 *
 * Stubs googleapis (OAuth2 + google.<api>) and auth/permissions.loadConfig so
 * no network/DB is touched. Asserts config/connection guards, credential wiring,
 * the on('tokens') write-back (default session.save vs onSaved override), the
 * caller-supplied not-connected error, and the multi-api/{oauth2Client} shape.
 *
 * Run: cd server && node --test --test-force-exit --test-timeout=30000 integrations/googleClient.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

let providerCfg;                 // what loadConfig().providers.google returns
let lastOAuth2;                  // the most recently constructed fake OAuth2

class FakeOAuth2 {
    constructor(clientId, clientSecret) {
        this.clientId = clientId; this.clientSecret = clientSecret;
        this.creds = null; this._tokensCb = null; lastOAuth2 = this;
    }
    setCredentials(c) { this.creds = c; }
    on(evt, cb) { if (evt === 'tokens') this._tokensCb = cb; }
    emitTokens(t) { this._tokensCb && this._tokensCb(t); }
}

const googleStub = {
    google: {
        auth: { OAuth2: FakeOAuth2 },
        gmail: (o) => ({ __api: 'gmail', ...o }),
        drive: (o) => ({ __api: 'drive', ...o }),
        sheets: (o) => ({ __api: 'sheets', ...o }),
        docs: (o) => ({ __api: 'docs', ...o }),
    },
};

const restore = installResolveStub({
    googleapis: googleStub,
    '../auth/permissions': { loadConfig: async () => ({ providers: { google: providerCfg } }) },
});

const { createGoogleApiClient, GOOGLE_RETRY_CONFIG } = require('./googleClient');

test('throws when Google OAuth not configured', async () => {
    providerCfg = {};
    await assert.rejects(
        () => createGoogleApiClient({ accessToken: 't' }, { api: 'gmail', version: 'v1' }),
        /Google OAuth not configured/,
    );
});

test('throws caller-supplied not-configured error (route verbose string)', async () => {
    providerCfg = {};
    await assert.rejects(
        () => createGoogleApiClient({ accessToken: 't' }, { api: 'gmail', version: 'v1', notConfiguredError: 'Google OAuth not configured. Set up Google SSO in Admin → Security.' }),
        /Set up Google SSO in Admin/,
    );
});

test('throws caller-supplied not-connected error when no accessToken', async () => {
    providerCfg = { clientId: 'id', clientSecret: 'sec' };
    await assert.rejects(
        () => createGoogleApiClient({}, { api: 'gmail', version: 'v1', notConnectedError: 'Not connected to Gmail — user must log in with Google' }),
        /Not connected to Gmail/,
    );
});

test('default not-connected error when none supplied', async () => {
    providerCfg = { clientId: 'id', clientSecret: 'sec' };
    await assert.rejects(
        () => createGoogleApiClient({}, { api: 'gmail', version: 'v1' }),
        /Not connected to Google/,
    );
});

test('happy path: builds OAuth2, sets creds, returns google[api] with version', async () => {
    providerCfg = { clientId: 'id', clientSecret: 'sec' };
    const session = { accessToken: 'acc', refreshToken: 'ref' };
    const client = await createGoogleApiClient(session, { api: 'gmail', version: 'v1' });
    assert.equal(client.__api, 'gmail');
    assert.equal(client.version, 'v1');
    assert.equal(client.auth, lastOAuth2);
    assert.equal(lastOAuth2.clientId, 'id');
    assert.deepEqual(lastOAuth2.creds, { access_token: 'acc', refresh_token: 'ref' });
    // Every client waits out Google's rate limits (googleClient.retry.test.js),
    // each with its own copy: gaxios writes its retry state into the object.
    assert.equal(client.retryConfig.shouldRetry, GOOGLE_RETRY_CONFIG.shouldRetry);
    assert.notEqual(client.retryConfig, GOOGLE_RETRY_CONFIG);
});

test("on('tokens') write-back: mutates session + calls session.save by default", async () => {
    providerCfg = { clientId: 'id', clientSecret: 'sec' };
    let saved = 0;
    const session = { accessToken: 'acc', refreshToken: 'ref', save: () => { saved++; } };
    await createGoogleApiClient(session, { api: 'gmail', version: 'v1' });
    lastOAuth2.emitTokens({ access_token: 'new-acc', refresh_token: 'new-ref' });
    assert.equal(session.accessToken, 'new-acc');
    assert.equal(session.refreshToken, 'new-ref');
    assert.equal(saved, 1);
});

test("on('tokens') keeps existing refresh token when response omits it", async () => {
    providerCfg = { clientId: 'id', clientSecret: 'sec' };
    const session = { accessToken: 'acc', refreshToken: 'ref', save: () => {} };
    await createGoogleApiClient(session, { api: 'gmail', version: 'v1' });
    lastOAuth2.emitTokens({ access_token: 'new-acc' }); // no refresh_token
    assert.equal(session.accessToken, 'new-acc');
    assert.equal(session.refreshToken, 'ref');
});

test('onSaved override is used instead of session.save', async () => {
    providerCfg = { clientId: 'id', clientSecret: 'sec' };
    let saved = 0, onSavedArg = null;
    const session = { accessToken: 'acc', refreshToken: 'ref', save: () => { saved++; } };
    await createGoogleApiClient(session, { api: 'gmail', version: 'v1', onSaved: (s) => { onSavedArg = s; } });
    lastOAuth2.emitTokens({ access_token: 'new-acc' });
    assert.equal(onSavedArg, session);
    assert.equal(saved, 0); // session.save NOT called when onSaved present
});

test('extraApis + exposeOAuth2 returns {[api], ...extras, oauth2Client} on one OAuth2', async () => {
    providerCfg = { clientId: 'id', clientSecret: 'sec' };
    const session = { accessToken: 'acc', refreshToken: 'ref' };
    const r = await createGoogleApiClient(session, {
        api: 'sheets', version: 'v4',
        extraApis: [{ api: 'drive', version: 'v3' }],
        exposeOAuth2: true,
    });
    assert.equal(r.sheets.__api, 'sheets');
    assert.equal(r.sheets.version, 'v4');
    assert.equal(r.drive.__api, 'drive');
    assert.equal(r.drive.version, 'v3');
    assert.equal(r.oauth2Client, lastOAuth2);
    // both clients share the same OAuth2 auth
    assert.equal(r.sheets.auth, r.drive.auth);
});

test.after(() => restore());
