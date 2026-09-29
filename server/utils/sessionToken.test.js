/**
 * The bridge token's shelf life, with no Redis.
 *
 * Every one of these cases is reachable on a single-instance self-host, which
 * is the deployment where the in-memory fallback IS the store rather than a
 * dev convenience — so "it works with Redis" is not an answer.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    getSessionToken,
    setSessionToken,
    generateToken,
    SESSION_TOKEN_TTL_SECONDS,
    NATIVE_SESSION_TOKEN_TTL_SECONDS,
} = require('./sessionToken');

test('a freshly minted token reads back', async () => {
    const token = generateToken();
    await setSessionToken(token, { user: { id: 'u1' } });
    assert.deepStrictEqual(await getSessionToken(token), { user: { id: 'u1' } });
});

test('an unknown token is null, not undefined', async () => {
    assert.strictEqual(await getSessionToken(generateToken()), null);
});

test('a token past its deadline reads back as gone', async () => {
    const token = generateToken();
    // Negative TTL rather than a timer wait: the deadline is checked on read,
    // which is the property under test. Waiting would only test setTimeout.
    await setSessionToken(token, { user: { id: 'u1' } }, -1);
    assert.strictEqual(await getSessionToken(token), null);
});

test('a 30-day native TTL survives minting — the regression this guards', async () => {
    // The bug this exists to catch: a bare setTimeout with a delay over the
    // signed 32-bit millisecond ceiling fires IMMEDIATELY in Node, so the
    // longest TTL in the system would have evicted its token on the same tick
    // it was written. A native token must still be there a moment later.
    const token = generateToken();
    await setSessionToken(token, { user: { id: 'u1' } }, NATIVE_SESSION_TOKEN_TTL_SECONDS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(await getSessionToken(token), { user: { id: 'u1' } });
});

test('the native TTL is the cookie\'s 30 days, and the default is still an hour', () => {
    assert.strictEqual(SESSION_TOKEN_TTL_SECONDS, 3600);
    assert.strictEqual(NATIVE_SESSION_TOKEN_TTL_SECONDS, 30 * 24 * 60 * 60);
});

test('generateToken does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
    assert.strictEqual(seen.size, 200);
    for (const t of seen) assert.match(t, /^[0-9a-f]{64}$/);
});

/**
 * Tripwires, in the spirit of the one at the bottom of
 * auth/sessionShapes.contract.test.js.
 *
 * The bridge rebuilds `req.session` verbatim from the token payload, so what a
 * payload does and does not carry is a security question, in both directions:
 *
 *   - A gate that is set once at login and never cleared (pendingApproval,
 *     noOrganization) MUST be carried. Leaving it out tells a bridged client
 *     that a user awaiting approval was approved.
 *   - A gate that is meant to be CLEARED (needsEncryptionSetup,
 *     needsEncryptionPin) must NOT be carried. save() is a no-op for a bridged
 *     request, so a frozen copy can never be turned off and the client is
 *     trapped on a gate screen for the life of the token.
 *
 * These are source-level because the alternative is standing up the whole
 * Express app to assert the presence and absence of six words. The writers are
 * DISCOVERED rather than listed: a third writer (the legacy Nextcloud OAuth
 * path) had been missed by a hand-kept list once already.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER_DIR = path.join(__dirname, '..');

/** Every file that mints a bridge token, found by search. */
function bridgeTokenWriters() {
    const out = execFileSync(
        'grep',
        ['-rl', '--include=*.js', 'setSessionToken(', SERVER_DIR],
        { encoding: 'utf8' },
    );
    return out
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.includes('node_modules'))
        .filter((f) => !f.endsWith('.test.js'))
        // The module that DEFINES it, not a writer.
        .filter((f) => path.resolve(f) !== path.resolve(__dirname, 'sessionToken.js'));
}

test('every bridge-token writer is discoverable, and there is more than one', () => {
    const writers = bridgeTokenWriters();
    assert.ok(writers.length >= 3, `expected at least 3 writers, found ${writers.length}`);
});

test('every bridge-token writer carries the sticky login gates', () => {
    for (const file of bridgeTokenWriters()) {
        const src = fs.readFileSync(file, 'utf8');
        for (const gate of ['pendingApproval', 'noOrganization']) {
            assert.ok(
                src.includes(gate),
                `${path.relative(SERVER_DIR, file)} mints a bridge token without ${gate}`,
            );
        }
    }
});

test('the re-mint does NOT carry the clearable encryption gates', () => {
    // The regression this exists to catch: adding these looks like a fix (the
    // OAuth callback deposits them) and is the opposite, because nothing can
    // ever clear them again over the bridge.
    const src = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
    const route = src.slice(src.indexOf("app.get('/api/session-token'"));
    const body = route.slice(0, route.indexOf('res.json('));
    for (const gate of ['needsEncryptionSetup:', 'needsEncryptionPin:']) {
        assert.ok(
            !body.includes(gate),
            `/api/session-token must not freeze ${gate} into a bridge token — it can never be cleared`,
        );
    }
});

test('key material is still kept out of the bridge store', () => {
    // The one thing that must NEVER be added to the payload. Zero-knowledge is
    // the product; a DEK in the token store would end it.
    const src = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
    const route = src.slice(src.indexOf("app.get('/api/session-token'"));
    const body = route.slice(0, route.indexOf('res.json('));
    assert.ok(
        !/encryptionKey:/.test(body),
        '/api/session-token must not put encryptionKey in the bridge token',
    );
});

test('signing out revokes the presented token', async () => {
    const { deleteSessionToken } = require('./sessionToken');
    const token = generateToken();
    await setSessionToken(token, { user: { id: 'u1' } });
    assert.notStrictEqual(await getSessionToken(token), null);

    await deleteSessionToken(token);
    assert.strictEqual(await getSessionToken(token), null);
});

test('revoking is safe to call with nothing to revoke', async () => {
    const { deleteSessionToken } = require('./sessionToken');
    await deleteSessionToken(undefined);
    await deleteSessionToken(generateToken());
});

test('a native token is not evicted early by the clamped timer', async () => {
    // The eviction timer cannot represent 30 days, so it fires at the 32-bit
    // ceiling and MUST re-arm rather than delete. A bare clamp would have
    // dropped the entry five days early — silently, and only where there is no
    // Redis.
    const token = generateToken();
    await setSessionToken(token, { user: { id: 'u1' } }, NATIVE_SESSION_TOKEN_TTL_SECONDS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(await getSessionToken(token), { user: { id: 'u1' } });
});
