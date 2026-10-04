/**
 * Automation Auth — refresh-failure classification tests.
 *
 * Pins getProviderAuth's error handling: only definitive OAuth rejections
 * (token endpoint answering `invalid_grant` / `invalid_client`, or a vault
 * entry with no refresh token at all) flip a credential to needs_reauth,
 * pause dependent automations and notify the user. Transient failures (provider
 * 5xx, network errors, malformed bodies) return null for the attempt WITHOUT
 * mutating credential status, so the next tick retries.
 *
 * Deps are stubbed via the Module resolve hook; global.fetch is stubbed for
 * the token refresh calls.
 *
 * Run: cd server && node --test auth/automationAuth.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    cred: null,             // automationCredentialStore.getCredential fixture
    upserts: [],            // automationCredentialStore.upsertCredential spy
    reauthMarks: [],        // automationCredentialStore.markNeedsReauth spy
    notifications: [],      // notificationStore.createNotification spy
    taskUpdates: [],        // coworkStore.updateSchedule spy
    tasks: [],              // coworkStore.getSchedules fixture
    fetchImpl: async () => { throw new Error('fetch not stubbed'); },
};

const MOCKS = {
    '../stores/automationCredentialStore': {
        getCredential: async () => fx.cred,
        upsertCredential: async (row) => { fx.upserts.push(row); },
        markNeedsReauth: async (userId, provider, message) => { fx.reauthMarks.push({ userId, provider, message }); },
    },
    './permissions': {
        OAUTH_PROVIDERS: {
            google: { tokenUrl: 'https://oauth2.googleapis.com/token' },
            microsoft: { tokenUrl: (tenantId) => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token` },
        },
        loadConfig: async () => ({
            providers: {
                google: { clientId: 'gid', clientSecret: 'gsecret' },
                microsoft: { clientId: 'mid', clientSecret: 'msecret' },
            },
        }),
        // Real behaviour: prefer the granted scope, else the default set.
        microsoftRefreshScope: (granted) => (typeof granted === 'string' && granted.trim())
            || 'openid email profile User.Read Mail.Read Mail.Send offline_access',
    },
    '../stores/coworkStore': {
        getSchedules: async () => fx.tasks,
        updateSchedule: async (id, patch) => { fx.taskUpdates.push({ id, patch }); },
    },
    '../stores/agentStore': {
        getAgent: async () => ({ config: { enabledIntegrations: [] } }),
    },
    '../stores/notificationStore': {
        createNotification: async (row) => { fx.notifications.push(row); },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:automationAuth:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]automationAuth\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const realFetch = global.fetch;
global.fetch = (...args) => fx.fetchImpl(...args);

const { getProviderAuth } = require('./automationAuth');

test.after(() => {
    Module._resolveFilename = originalResolve;
    global.fetch = realFetch;
});

function makeCred(provider = 'google') {
    return {
        userId: 'u1',
        orgId: 'org1',
        provider,
        status: 'active',
        accessToken: 'old_at',
        refreshToken: 'rt_1',
        expiresAt: Date.now() - 1000, // expired → forces refresh
        scope: 'scopeA',
    };
}

function resetFx(provider = 'google') {
    fx.cred = makeCred(provider);
    fx.upserts.length = 0;
    fx.reauthMarks.length = 0;
    fx.notifications.length = 0;
    fx.taskUpdates.length = 0;
    // One Cowork schedule without an agent → paused on reauth.
    fx.tasks = [{ id: 't1', isActive: true }];
    fx.fetchImpl = async () => { throw new Error('fetch not stubbed'); };
}

function httpResponse(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        json: async () => JSON.parse(text),
    };
}

function assertNoStateMutation() {
    assert.strictEqual(fx.reauthMarks.length, 0, 'markNeedsReauth must not be called');
    assert.strictEqual(fx.upserts.length, 0, 'upsertCredential must not be called');
    assert.strictEqual(fx.notifications.length, 0, 'no notification must be emitted');
    assert.strictEqual(fx.taskUpdates.length, 0, 'no automation must be paused');
    assert.strictEqual(fx.cred.status, 'active');
}

test('400 invalid_grant → needs_reauth + pause + notify', async () => {
    resetFx();
    fx.fetchImpl = async () => httpResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });

    const result = await getProviderAuth('u1', 'google');

    assert.strictEqual(result, null);
    assert.strictEqual(fx.reauthMarks.length, 1);
    assert.strictEqual(fx.reauthMarks[0].userId, 'u1');
    assert.strictEqual(fx.reauthMarks[0].provider, 'google');
    assert.match(fx.reauthMarks[0].message, /invalid_grant/);
    assert.strictEqual(fx.upserts.length, 0);
    // lastStatus travels with the pause: resumeNeedsReauthForUser only matches
    // rows stamped 'needs_reauth', so a pause without it is unresumable.
    assert.deepStrictEqual(fx.taskUpdates, [{ id: 't1', patch: { isActive: false, lastStatus: 'needs_reauth' } }]);
    assert.strictEqual(fx.notifications.length, 1);
    assert.strictEqual(fx.notifications[0].category, 'urgent');
    assert.match(fx.notifications[0].message, /automation_reauth:google/);
});

test('401 invalid_client → needs_reauth', async () => {
    resetFx();
    fx.fetchImpl = async () => httpResponse(401, { error: 'invalid_client' });

    const result = await getProviderAuth('u1', 'google');

    assert.strictEqual(result, null);
    assert.strictEqual(fx.reauthMarks.length, 1);
    assert.strictEqual(fx.notifications.length, 1);
});

test('500 (non-JSON body) → transient: null, no state mutation', async () => {
    resetFx();
    fx.fetchImpl = async () => httpResponse(500, 'Internal Server Error');

    const result = await getProviderAuth('u1', 'google');

    assert.strictEqual(result, null);
    assertNoStateMutation();
});

test('500 with a JSON error other than invalid_grant/invalid_client → transient', async () => {
    resetFx();
    fx.fetchImpl = async () => httpResponse(500, { error: 'internal_failure' });

    const result = await getProviderAuth('u1', 'google');

    assert.strictEqual(result, null);
    assertNoStateMutation();
});

test('network throw → transient: null, no state mutation', async () => {
    resetFx();
    fx.fetchImpl = async () => { throw new Error('fetch failed: ECONNRESET'); };

    const result = await getProviderAuth('u1', 'google');

    assert.strictEqual(result, null);
    assertNoStateMutation();
});

test('200 with malformed JSON body → transient', async () => {
    resetFx();
    fx.fetchImpl = async () => ({
        ok: true,
        status: 200,
        text: async () => 'not json',
        json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    const result = await getProviderAuth('u1', 'google');

    assert.strictEqual(result, null);
    assertNoStateMutation();
});

test('missing refresh token → needs_reauth (retry can never succeed)', async () => {
    resetFx();
    fx.cred.refreshToken = null;

    const result = await getProviderAuth('u1', 'google');

    assert.strictEqual(result, null);
    assert.strictEqual(fx.reauthMarks.length, 1);
    assert.strictEqual(fx.notifications.length, 1);
});

test('successful refresh → upsert + fresh tokens, no reauth', async () => {
    resetFx();
    fx.fetchImpl = async () => httpResponse(200, { access_token: 'at_2', expires_in: 3600, scope: 'scopeB' });

    const result = await getProviderAuth('u1', 'google');

    assert.strictEqual(result.accessToken, 'at_2');
    assert.strictEqual(result.refreshToken, 'rt_1'); // Google reuses the old refresh token
    assert.strictEqual(fx.upserts.length, 1);
    assert.strictEqual(fx.upserts[0].accessToken, 'at_2');
    assert.strictEqual(fx.reauthMarks.length, 0);
    assert.strictEqual(fx.notifications.length, 0);
});

test('microsoft: 400 invalid_grant → needs_reauth + notify', async () => {
    resetFx('microsoft');
    fx.fetchImpl = async (url) => {
        assert.match(String(url), /login\.microsoftonline\.com\/common/);
        return httpResponse(400, { error: 'invalid_grant' });
    };

    const result = await getProviderAuth('u1', 'microsoft');

    assert.strictEqual(result, null);
    assert.strictEqual(fx.reauthMarks.length, 1);
    assert.strictEqual(fx.reauthMarks[0].provider, 'microsoft');
    assert.match(fx.notifications[0].message, /automation_reauth:microsoft/);
});

test('microsoft: a refresh re-requests the GRANTED scope, never a narrower default', async () => {
    // A user who consented to shared-mailbox scopes through the integration
    // connect flow must keep them; re-requesting only the login set would
    // silently strip Mail.*.Shared on the next refresh.
    resetFx('microsoft');
    fx.cred.scope = 'openid profile email Mail.Read Mail.Send Mail.Read.Shared Mail.Send.Shared offline_access';
    let sentScope = null;
    fx.fetchImpl = async (_url, opts) => {
        sentScope = new URLSearchParams(opts.body).get('scope');
        return httpResponse(200, { access_token: 'at_ms', expires_in: 3600 });
    };

    const result = await getProviderAuth('u1', 'microsoft');

    assert.strictEqual(result.accessToken, 'at_ms');
    assert.strictEqual(sentScope, fx.cred.scope);
    assert.match(sentScope, /Mail\.Read\.Shared/);
});

test('microsoft: 503 → transient', async () => {
    resetFx('microsoft');
    fx.fetchImpl = async () => httpResponse(503, 'Service Unavailable');

    const result = await getProviderAuth('u1', 'microsoft');

    assert.strictEqual(result, null);
    assertNoStateMutation();
});
