/**
 * Withings token refresh — envelope handling and failure classification.
 *
 * Withings breaks two assumptions the standards-compliant refreshers make, and
 * both are load-bearing:
 *
 *   1. HTTP 200 does not mean success. A refusal arrives as 200 with a non-zero
 *      `status`, and the tokens live one level down under `body`. Reading
 *      `data.access_token` would store `undefined` and every later call 401s.
 *   2. The refresh token is SINGLE USE — Withings rotates it and invalidates the
 *      old one. Falling back to the previous token (as the Google refresher
 *      legitimately does) would break the refresh after next.
 *
 * Run: cd server && node --test auth/routineAuth.withings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    clientId: 'wid',
    clientSecret: 'wsecret',
    fetchImpl: async () => { throw new Error('fetch not stubbed'); },
};

const MOCKS = {
    '../stores/routineCredentialStore': {
        getCredential: async () => null,
        upsertCredential: async () => {},
        markNeedsReauth: async () => {},
    },
    './permissions': {
        OAUTH_PROVIDERS: {
            withings: { tokenUrl: 'https://wbsapi.withings.net/v2/oauth2', apiBase: 'https://wbsapi.withings.net' },
        },
        loadConfig: async () => ({ providers: {} }),
        microsoftRefreshScope: (g) => g || '',
    },
    '../stores/configStore': {
        getSecret: async (key) => {
            if (key === 'withings_client_id') return fx.clientId;
            if (key === 'withings_client_secret') return fx.clientSecret;
            return null;
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:routineAuthWithings:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]routineAuth\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const realFetch = global.fetch;
global.fetch = (...args) => fx.fetchImpl(...args);

const routineAuth = require('./routineAuth');

test.after(() => {
    global.fetch = realFetch;
    Module._resolveFilename = originalResolve;
});

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
    return {
        ok, status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    };
}

// ── The happy path ───────────────────────────────────────────────────

test('refreshWithings unwraps `body` and sends the action-dispatched form', async () => {
    let seenBody = null;
    let seenUrl = null;
    fx.fetchImpl = async (url, opts) => {
        seenUrl = url;
        seenBody = new URLSearchParams(opts.body);
        return jsonResponse({
            status: 0,
            body: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 10800, scope: 'user.metrics' },
        });
    };

    const before = Date.now();
    const out = await routineAuth.refreshWithings({ refreshToken: 'RT1', scope: 'user.info' });

    assert.strictEqual(seenUrl, 'https://wbsapi.withings.net/v2/oauth2');
    // The action field is what makes this endpoint answer at all.
    assert.strictEqual(seenBody.get('action'), 'requesttoken');
    assert.strictEqual(seenBody.get('grant_type'), 'refresh_token');
    assert.strictEqual(seenBody.get('refresh_token'), 'RT1');
    assert.strictEqual(seenBody.get('client_id'), 'wid');
    assert.strictEqual(seenBody.get('client_secret'), 'wsecret');

    assert.strictEqual(out.accessToken, 'AT2');
    assert.strictEqual(out.refreshToken, 'RT2');
    assert.strictEqual(out.scope, 'user.metrics');
    assert.ok(out.expiresAt >= before + 10800_000 && out.expiresAt <= Date.now() + 10800_000);
});

test('refreshWithings never re-uses the old refresh token (Withings rotates it)', async () => {
    fx.fetchImpl = async () => jsonResponse({ status: 0, body: { access_token: 'AT2', expires_in: 10800 } });
    const out = await routineAuth.refreshWithings({ refreshToken: 'RT1' });
    // Google's refresher falls back to cred.refreshToken here. Doing that for
    // Withings would persist a token the provider has already invalidated.
    assert.strictEqual(out.refreshToken, null);
});

// ── Failure classification ───────────────────────────────────────────

test('a 200 with a non-zero auth status is a REAUTH failure, not a success', async () => {
    fx.fetchImpl = async () => jsonResponse({ status: 401, error: 'invalid_token' });
    await assert.rejects(
        () => routineAuth.refreshWithings({ refreshToken: 'RT1' }),
        (err) => err.reauthRequired === true && /status 401/.test(err.message),
    );
});

test('an invalid_grant error string is fatal whatever the status number', async () => {
    fx.fetchImpl = async () => jsonResponse({ status: 100, error: 'invalid_grant: refresh token expired' });
    await assert.rejects(
        () => routineAuth.refreshWithings({ refreshToken: 'RT1' }),
        (err) => err.reauthRequired === true,
    );
});

test('status 503 (invalid params) is TRANSIENT — it must not burn the credential', async () => {
    fx.fetchImpl = async () => jsonResponse({ status: 503, error: 'Invalid Params' });
    await assert.rejects(
        () => routineAuth.refreshWithings({ refreshToken: 'RT1' }),
        (err) => !err.reauthRequired && /status 503/.test(err.message),
    );
});

test('status 601 (rate limited) is TRANSIENT', async () => {
    fx.fetchImpl = async () => jsonResponse({ status: 601, error: 'Too Many Requests' });
    await assert.rejects(
        () => routineAuth.refreshWithings({ refreshToken: 'RT1' }),
        (err) => !err.reauthRequired,
    );
});

test('status 0 with no body is an error rather than a silent empty credential', async () => {
    fx.fetchImpl = async () => jsonResponse({ status: 0 });
    await assert.rejects(
        () => routineAuth.refreshWithings({ refreshToken: 'RT1' }),
        (err) => /no body/i.test(err.message),
    );
});

test('status 0 with a body but no access token demands re-auth', async () => {
    fx.fetchImpl = async () => jsonResponse({ status: 0, body: { refresh_token: 'RT2' } });
    await assert.rejects(
        () => routineAuth.refreshWithings({ refreshToken: 'RT1' }),
        (err) => err.reauthRequired === true && /no access token/i.test(err.message),
    );
});

test('a missing refresh token demands re-auth without calling Withings', async () => {
    let called = false;
    fx.fetchImpl = async () => { called = true; return jsonResponse({ status: 0, body: {} }); };
    await assert.rejects(
        () => routineAuth.refreshWithings({ refreshToken: null }),
        (err) => err.reauthRequired === true,
    );
    assert.strictEqual(called, false);
});

test('an unconfigured deployment fails transiently — the grant is fine, the app is not', async () => {
    fx.clientId = '';
    try {
        await assert.rejects(
            () => routineAuth.refreshWithings({ refreshToken: 'RT1' }),
            (err) => !err.reauthRequired && /not configured/i.test(err.message),
        );
    } finally {
        fx.clientId = 'wid';
    }
});

test('a transport-level 500 is classified by the shared throwRefreshFailed path', async () => {
    fx.fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'upstream boom' });
    await assert.rejects(
        () => routineAuth.refreshWithings({ refreshToken: 'RT1' }),
        (err) => !err.reauthRequired && /Withings refresh failed \(500\)/.test(err.message),
    );
});

// ── The refresher is reachable through the public entry point ────────

test('withings is registered in REFRESHERS (getProviderAuth can refresh it)', () => {
    // Not exported directly; the INTEGRATION_PROVIDER map is the observable
    // proof that the provider is wired into the same machinery.
    assert.deepStrictEqual(routineAuth.providersForIntegrations(['withings']), ['withings']);
});
