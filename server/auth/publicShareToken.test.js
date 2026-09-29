/**
 * Public-share token — view + bridge purpose round-trips, cross-purpose replay
 * isolation, and the durable-secret bootstrap that makes two replicas agree
 * (BFSF-420). The round-trip cases use a fixed env secret so the module signs
 * deterministically within the process; the bootstrap cases at the bottom
 * deliberately clear it.
 *
 * Run: node --test --test-force-exit auth/publicShareToken.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const MODULE_PATH = require.resolve('./publicShareToken');

function freshModule() {
    delete require.cache[MODULE_PATH];
    return require('./publicShareToken');
}

const ENV = { PUBLIC_SHARE_TOKEN_SECRET: 's'.repeat(48) };
function withSecret(fn) {
    const prev = process.env.PUBLIC_SHARE_TOKEN_SECRET;
    process.env.PUBLIC_SHARE_TOKEN_SECRET = ENV.PUBLIC_SHARE_TOKEN_SECRET;
    try { return fn(freshModule()); }
    finally {
        if (prev === undefined) delete process.env.PUBLIC_SHARE_TOKEN_SECRET;
        else process.env.PUBLIC_SHARE_TOKEN_SECRET = prev;
        delete require.cache[MODULE_PATH];
    }
}

test('view token round-trips and binds to the share id', () => {
    withSecret((m) => {
        const t = m.issueViewToken({ shareId: 'share-1' });
        const claim = m.verifyViewToken(t, 'share-1');
        assert.ok(claim);
        assert.strictEqual(claim.shareId, 'share-1');
        // Wrong share id is rejected.
        assert.strictEqual(m.verifyViewToken(t, 'share-2'), null);
    });
});

test('view token carries the viewer email for email-mode re-checks', () => {
    withSecret((m) => {
        const t = m.issueViewToken({ shareId: 's', email: 'A@Example.com' });
        const claim = m.verifyViewToken(t, 's');
        assert.strictEqual(claim.email, 'a@example.com'); // normalized lowercase
    });
});

test('bridge token round-trips and binds to share + webpage', () => {
    withSecret((m) => {
        const t = m.issueBridgeToken({ shareId: 's1', webpageId: 'w1' });
        const claim = m.verifyBridgeToken(t);
        assert.ok(claim);
        assert.strictEqual(claim.shareId, 's1');
        assert.strictEqual(claim.webpageId, 'w1');
    });
});

test('a view token cannot be replayed as a bridge token (purpose isolation)', () => {
    withSecret((m) => {
        const view = m.issueViewToken({ shareId: 's' });
        assert.strictEqual(m.verifyBridgeToken(view), null);
        const bridge = m.issueBridgeToken({ shareId: 's', webpageId: 'w' });
        assert.strictEqual(m.verifyViewToken(bridge, 's'), null);
        // And neither is accepted as an unlock cookie.
        assert.strictEqual(m.verifyUnlockCookie(view, 's'), null);
        assert.strictEqual(m.verifyUnlockCookie(bridge, 's'), null);
    });
});

test('tampered tokens are rejected', () => {
    withSecret((m) => {
        const t = m.issueBridgeToken({ shareId: 's', webpageId: 'w' });
        const tampered = t.slice(0, -2) + (t.endsWith('a') ? 'b' : 'a');
        assert.strictEqual(m.verifyBridgeToken(tampered), null);
        assert.strictEqual(m.verifyBridgeToken('garbage'), null);
        assert.strictEqual(m.verifyBridgeToken(''), null);
        assert.strictEqual(m.verifyBridgeToken(null), null);
    });
});

// ── Durable secret bootstrap (BFSF-420) ────────────────────────────
//
// The bug these pin: with no PUBLIC_SHARE_TOKEN_SECRET set, production fell
// through to a per-process crypto.randomBytes(32), so each replica signed with
// its own key. A public form rendered by pod A carried a CSRF token that pod B
// rejected, and the visitor got "This form expired" on the first submit —
// succeeding only when the retry round-robined back to pod A.
//
// NOTE ON THE HARNESS — these cases MUST pin NODE_ENV=production and clear the
// env var. Under the suite's own NODE_ENV=test the ladder takes its dev-disk
// branch, which is keyed on cwd: two freshly-required instances read the same
// file and therefore agree even WITHOUT the fix, so the naive version of the
// "two pods" test passes on the bug.

/** require.cache stub, same trick as routes/automation/formPublic.test.js. */
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// signingSecret.ensureDurable() lazily requires this from inside the function,
// so stubbing the cache entry before the call is enough. Without a stub it
// would reach the real configStore, whose initDB() has no database here.
const CONFIG_STORE = path.resolve(__dirname, '..', 'stores', 'configStore');

// What setSecretIfAbsent hands every replica back: the single row the first
// booting pod inserted (ON CONFLICT DO NOTHING), not each caller's own candidate.
const BOOTSTRAPPED = 'f'.repeat(96);

/**
 * webpagePreviewToken.test.js's env harness, made await-safe: these bodies do
 * async work, so the env has to stay swapped until the body has actually
 * finished rather than until it has returned its promise.
 */
async function withEnv(vars, fn) {
    const prev = {};
    for (const k of Object.keys(vars)) prev[k] = process.env[k];
    Object.assign(process.env, vars);
    try { return await fn(); }
    finally {
        for (const k of Object.keys(vars)) {
            if (prev[k] === undefined) delete process.env[k];
            else process.env[k] = prev[k];
        }
        delete require.cache[MODULE_PATH];
    }
}

async function withConfigStore(stub, fn) {
    const p = require.resolve(CONFIG_STORE);
    const had = Object.prototype.hasOwnProperty.call(require.cache, p);
    const prev = require.cache[p];
    mock(CONFIG_STORE, stub);
    try { return await fn(); }
    finally {
        if (had) require.cache[p] = prev;
        else delete require.cache[p];
    }
}

test('two replicas that bootstrap the same configStore secret agree on a form CSRF (BFSF-420)', async () => {
    await withEnv({ NODE_ENV: 'production', PUBLIC_SHARE_TOKEN_SECRET: '' }, async () => {
        const keys = [];
        await withConfigStore({
            setSecretIfAbsent: async (key) => { keys.push(key); return BOOTSTRAPPED; },
        }, async () => {
            const podA = freshModule();
            assert.strictEqual(await podA.ensureDurableSecret(), true);
            assert.strictEqual(podA.hasDurableSecret(), true);

            const podB = freshModule();
            assert.strictEqual(await podB.ensureDurableSecret(), true);
            assert.notStrictEqual(podA, podB, 'the two pods must be separate module instances');

            // Each pod bootstrapped under the feature's own key — never a key
            // shared with certificateToken or webpagePreviewToken.
            assert.deepStrictEqual(keys, ['public_share_token_secret', 'public_share_token_secret']);

            // The property the bug broke: minted on one pod, verified on the other.
            const csrf = podA.issueCsrf('share-1');
            assert.strictEqual(podB.verifyCsrf(csrf, 'share-1'), true,
                'a CSRF minted by one replica must verify on its sibling');
            assert.strictEqual(podB.verifyCsrf(csrf, 'share-2'), false,
                'agreeing on the secret must not weaken the share-id binding');

            // Same for the anonymous Studio-app identity, where a rejection on
            // the wrong pod silently re-mints a viewerId and orphans its rows.
            const visitor = podA.issueVisitorToken({ pageToken: 'p1', appId: 'a1', viewerId: 'v1' });
            assert.strictEqual(podB.verifyVisitorToken(visitor, 'p1')?.viewerId, 'v1');
        });
    });
});

test('ensureDurableSecret short-circuits (no configStore call) when the env secret is already set', async () => {
    await withEnv({ NODE_ENV: 'production', PUBLIC_SHARE_TOKEN_SECRET: 'x'.repeat(48) }, async () => {
        let calls = 0;
        await withConfigStore({
            setSecretIfAbsent: async () => { calls += 1; return BOOTSTRAPPED; },
        }, async () => {
            const mod = freshModule();
            assert.strictEqual(await mod.ensureDurableSecret(), true);
            assert.strictEqual(mod.hasDurableSecret(), true);
            assert.strictEqual(calls, 0, 'an operator-set env secret must win untouched');
        });
    });
});

test('ensureDurableSecret never throws when configStore is unreachable, and the request path keeps minting', async () => {
    await withEnv({ NODE_ENV: 'production', PUBLIC_SHARE_TOKEN_SECRET: '' }, async () => {
        await withConfigStore({
            setSecretIfAbsent: async () => { throw new Error('no database'); },
        }, async () => {
            const mod = freshModule();
            const ok = await mod.ensureDurableSecret();
            assert.strictEqual(ok, false, 'no env var and no configStore ⇒ not durable');
            // Non-fatal on purpose: a request landing in the startup window (or
            // on a broken configStore) must still get a token rather than a 500.
            // It just will not verify on a sibling replica — which is exactly
            // what the loud production warning says.
            const csrf = mod.issueCsrf('s');
            assert.strictEqual(mod.verifyCsrf(csrf, 's'), true);
        });
    });
});
