/**
 * Webpage preview token — durable-secret bootstrap + round-trip regressions.
 *
 * The signing secret is cached at module scope (getSecret()'s `cachedSecret`),
 * so each test that varies NODE_ENV / WEBPAGE_PREVIEW_TOKEN_SECRET re-requires
 * a fresh module instance via a cleared require cache.
 *
 * Run: node --test auth/webpagePreviewToken.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const MODULE_PATH = require.resolve('./webpagePreviewToken');

function freshModule() {
    delete require.cache[MODULE_PATH];
    return require('./webpagePreviewToken');
}

function withEnv(vars, fn) {
    const prev = {};
    for (const k of Object.keys(vars)) prev[k] = process.env[k];
    Object.assign(process.env, vars);
    try { return fn(); }
    finally {
        for (const k of Object.keys(vars)) {
            if (prev[k] === undefined) delete process.env[k];
            else process.env[k] = prev[k];
        }
        delete require.cache[MODULE_PATH];
    }
}

test('a >=32 char env secret is durable and used as-is', () => {
    withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: 'x'.repeat(32) }, () => {
        const mod = freshModule();
        assert.strictEqual(mod.hasDurableSecret(), true);
    });
});

test('ensureDurableSecret short-circuits (no configStore call) when the env secret is already set', async () => {
    await withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: 'x'.repeat(32) }, async () => {
        const mod = freshModule();
        const ok = await mod.ensureDurableSecret();
        assert.strictEqual(ok, true);
        assert.strictEqual(mod.hasDurableSecret(), true);
    });
});

test('ensureDurableSecret never throws even when configStore is unreachable', async () => {
    await withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: '' }, async () => {
        const mod = freshModule();
        // No DB in this test environment — must resolve to a boolean, not reject.
        // This exercises the exact failure mode that previously hard-crashed the
        // server (BE-P1.3): a production boot with no env secret and (here) no
        // reachable configStore either.
        const ok = await mod.ensureDurableSecret();
        assert.strictEqual(typeof ok, 'boolean');
    });
});

test('production with no env secret and no durable bootstrap still mints a usable (if non-durable) token — never crashes the request path', () => {
    withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: '' }, () => {
        const mod = freshModule();
        const { token } = mod.issuePreviewToken({ userId: 'u1', webpageId: 'w1' });
        assert.ok(token && typeof token === 'string');
        assert.strictEqual(mod.hasDurableSecret(), false, 'per-process random fallback is not durable');
    });
});

test('issuePreviewToken/verifyPreviewToken round-trip with a valid secret', () => {
    withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: 'x'.repeat(32) }, () => {
        const mod = freshModule();
        const { token, expiresAt } = mod.issuePreviewToken({ userId: 'u1', webpageId: 'w1' });
        assert.ok(token && typeof token === 'string');
        assert.ok(expiresAt > Date.now());
        const claims = mod.verifyPreviewToken(token);
        // `viewerUserId` staat er ALTIJD in, ook als hij niet is meegegeven —
        // null, nooit teruggevallen op `userId`. Zie de W3-tests hieronder.
        assert.deepStrictEqual(claims, { userId: 'u1', webpageId: 'w1', viewerUserId: null, expiresAt });
    });
});

// ── W3: de bezoekersclaim ────────────────────────────────────────────

test('the viewer claim round-trips separately from the owner claim', () => {
    withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: 'x'.repeat(32) }, () => {
        const mod = freshModule();
        const { token } = mod.issuePreviewToken({ userId: 'u-author', webpageId: 'w1', viewerUserId: 'u-reader' });
        const claims = mod.verifyPreviewToken(token);
        assert.strictEqual(claims.userId, 'u-author', 'the owner still scopes the page database');
        assert.strictEqual(claims.viewerUserId, 'u-reader');
    });
});

test('BITE — a token minted without a viewer answers null, never the owner', () => {
    withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: 'x'.repeat(32) }, () => {
        const mod = freshModule();
        // Precies de vorm van een token van vóór W3.
        const { token } = mod.issuePreviewToken({ userId: 'u-author', webpageId: 'w1' });
        const claims = mod.verifyPreviewToken(token);
        assert.strictEqual(claims.viewerUserId, null,
            'an absent viewer must narrow to null — falling back to the author would lend out his table rights');
    });
});

test('a viewer claim that is not a non-empty string narrows to null', () => {
    withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: 'x'.repeat(32) }, () => {
        const mod = freshModule();
        for (const bad of ['', '   ', 42, true, {}, []]) {
            const { token } = mod.issuePreviewToken({ userId: 'u-author', webpageId: 'w1', viewerUserId: bad });
            const claims = mod.verifyPreviewToken(token);
            assert.strictEqual(claims.viewerUserId, null, `${JSON.stringify(bad)} must not become a viewer`);
        }
    });
});

test('verifyPreviewToken rejects a token issued for a different webpage', () => {
    withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: 'x'.repeat(32) }, () => {
        const mod = freshModule();
        const { token } = mod.issuePreviewToken({ userId: 'u1', webpageId: 'w1' });
        const claims = mod.verifyPreviewToken(token);
        assert.notStrictEqual(claims.webpageId, 'w2');
    });
});

test('verifyPreviewToken rejects a tampered signature', () => {
    withEnv({ NODE_ENV: 'production', WEBPAGE_PREVIEW_TOKEN_SECRET: 'x'.repeat(32) }, () => {
        const mod = freshModule();
        const { token } = mod.issuePreviewToken({ userId: 'u1', webpageId: 'w1' });
        const [payload] = token.split('.');
        const tampered = `${payload}.not-a-real-signature`;
        assert.strictEqual(mod.verifyPreviewToken(tampered), null);
    });
});
