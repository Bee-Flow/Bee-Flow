// @typecheck strict
/**
 * The native-app handoff allowlist.
 *
 * This is the one place a redirect target exists for the OAuth callback's
 * native path, and the whole security argument for that path is that the
 * client sends a KEY rather than a URL — so there is no URI for anyone to
 * craft and no parser to fool. These tests exist to keep it that way: the day
 * someone "improves" this into a prefix match or an allowlist of hosts, they
 * should have to delete a test that says why not.
 */

const test = require('node:test');
const assert = require('node:assert');

const { resolveNativeAppRedirect, getReturnUrl } = require('./shared');

test('resolves the known key to its fixed target', () => {
    assert.strictEqual(resolveNativeAppRedirect('beeflow'), 'beeflow://oauth');
});

test('returns null for anything else', () => {
    for (const key of ['', 'unknown', 'BEEFLOW', 'beeflow ', ' beeflow']) {
        assert.strictEqual(resolveNativeAppRedirect(key), null, `key: ${JSON.stringify(key)}`);
    }
});

test('cannot be walked out of via the prototype chain', () => {
    // A Map, not an object literal — `?app=constructor` must not resolve to a
    // function, and `?app=__proto__` must not resolve to anything at all.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        assert.strictEqual(resolveNativeAppRedirect(key), null, `key: ${key}`);
    }
});

test('never reflects the caller’s own string', () => {
    // The failure this guards is an allowlist that string-matches a supplied
    // URI. Every one of these is a real bypass of a naive startsWith check.
    const attempts = [
        'beeflow://oauth@evil.example',
        'beeflow:/\\/oauth',
        'beeflow://oauth.evil.example',
        'https://evil.example',
        'javascript:alert(1)',
        'beeflow://oauth#@evil.example',
    ];
    for (const attempt of attempts) {
        assert.strictEqual(resolveNativeAppRedirect(attempt), null, `attempt: ${attempt}`);
    }
});

test('ignores non-strings rather than coercing them', () => {
    for (const key of [undefined, null, 0, 1, true, {}, [], ['beeflow'], Symbol.iterator]) {
        assert.strictEqual(resolveNativeAppRedirect(key), null);
    }
});

// ── Where the browser goes after the callback ──────────────────────────
/** @param {Record<string, string>} headers */
const reqWith = (headers, { protocol = 'https', host = 'bee.example' } = {}) => /** @type {any} */ ({
    protocol,
    /** @param {string} name */
    get(name) {
        const key = String(name).toLowerCase();
        if (key === 'host') return host;
        return Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : undefined;
    },
});
/** @param {Record<string, string | undefined>} patch @param {() => void | Promise<void>} fn */
const withEnv = async (patch, fn) => {
    /** @type {Record<string, string | undefined>} */
    const before = {};
    for (const [k, v] of Object.entries(patch)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { await fn(); } finally {
        for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
};

test('getReturnUrl: the configured client host wins everywhere', () => withEnv(
    { CLIENT_PUBLIC_HOST: 'app.example', CLIENT_PROTOCOL: 'https', NODE_ENV: 'production' },
    () => { assert.strictEqual(getReturnUrl(reqWith({ referer: 'https://attacker.example/' })), 'https://app.example'); },
));

test('getReturnUrl: outside production the Referer decides when nothing is configured', () => withEnv(
    { CLIENT_PUBLIC_HOST: undefined, NODE_ENV: 'test' },
    () => {
        assert.strictEqual(getReturnUrl(reqWith({ referer: 'http://localhost:5276/login?x=1' })), 'http://localhost:5276');
        assert.strictEqual(getReturnUrl(reqWith({})), 'http://localhost:5173');
    },
));

test('getReturnUrl: in production the Referer is never a target', () => withEnv(
    { CLIENT_PUBLIC_HOST: undefined, SERVER_PUBLIC_HOST: undefined, NODE_ENV: 'production' },
    async () => {
        assert.strictEqual(getReturnUrl(reqWith({ referer: 'https://attacker.example/' })), 'https://bee.example',
            'the server\'s own origin, not the page that sent the browser');
        await withEnv({ SERVER_PUBLIC_HOST: 'hub.example', SERVER_PROTOCOL: 'https' }, () => {
            assert.strictEqual(getReturnUrl(reqWith({ referer: 'https://attacker.example/' })), 'https://hub.example');
        });
    },
));

test('the vault copy of a sign-in keeps the access and the refresh token, the scope and the expiry', async () => {
    const { _vaultUpsertSafe } = require('./shared');
    const credentialStore = require('../../stores/automationCredentialStore');
    const coworkStore = require('../../stores/coworkStore');
    const real = { upsert: credentialStore.upsertCredential, resume: coworkStore.resumeNeedsReauthForUser };
    /** @type {Record<string, unknown>[]} */
    const saved = [];
    /** @type {string[]} */
    const resumedFor = [];
    credentialStore.upsertCredential = /** @type {typeof credentialStore.upsertCredential} */ (/** @type {unknown} */ (async (/** @type {Record<string, unknown>} */ row) => { saved.push(row); }));
    coworkStore.resumeNeedsReauthForUser = /** @type {typeof coworkStore.resumeNeedsReauthForUser} */ (/** @type {unknown} */ (async (/** @type {string} */ userId) => { resumedFor.push(userId); return 0; }));
    try {
        const before = Date.now();
        await _vaultUpsertSafe({ userId: 'u1', orgId: 'o1', provider: 'google', tokenData: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: '3600', scope: 'mail calendar' } });
        assert.strictEqual(saved.length, 1);
        const { expiresAt, ...row } = saved[0];
        assert.deepStrictEqual(row, { userId: 'u1', orgId: 'o1', provider: 'google', accessToken: 'at-1', refreshToken: 'rt-1', scope: 'mail calendar' });
        assert.ok(typeof expiresAt === 'number' && expiresAt >= before + 3_600_000 && expiresAt <= Date.now() + 3_600_000, String(expiresAt));
        assert.deepStrictEqual(resumedFor, ['u1'], 'automations paused for a new sign-in are picked up again');

        // What the provider left out is stored as absent, not as an empty string or a guess.
        await _vaultUpsertSafe({ userId: 'u1', orgId: 'o1', provider: 'google', tokenData: {} });
        assert.deepStrictEqual(saved[1], { userId: 'u1', orgId: 'o1', provider: 'google', accessToken: null, refreshToken: null, expiresAt: null, scope: null });

        // Without a user, an organisation, a provider or tokens there is nothing to store.
        for (const partial of [{ orgId: 'o1', provider: 'google', tokenData: {} }, { userId: 'u1', provider: 'google', tokenData: {} }, { userId: 'u1', orgId: 'o1', tokenData: {} }, { userId: 'u1', orgId: 'o1', provider: 'google' }]) {
            await _vaultUpsertSafe(partial);
        }
        assert.strictEqual(saved.length, 2);

        // A vault that fails does not fail the sign-in.
        credentialStore.upsertCredential = /** @type {typeof credentialStore.upsertCredential} */ (/** @type {unknown} */ (async () => { throw new Error('vault down'); }));
        await _vaultUpsertSafe({ userId: 'u1', orgId: 'o1', provider: 'google', tokenData: { access_token: 'at-2' } });
    } finally {
        credentialStore.upsertCredential = real.upsert;
        coworkStore.resumeNeedsReauthForUser = real.resume;
    }
});
