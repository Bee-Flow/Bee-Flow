/**
 * Build-stamped `_lic:` session memo — U3.
 *
 * resolveBestTierForRequest memoises the tier resolution on req.session. That
 * session record is cross-process state (Postgres user_sessions + the bf:sess
 * Redis cache), while the v<N> slot in the key reads the IN-PROCESS
 * server-licence counter — so during a rolling deploy an old and a new pod
 * would read each other's memos under the same v<N>. buildKey() stamps the
 * build version into the key to close that gap. Pinned here:
 *   - the memo is written under exactly buildKey(`_lic:<id>:v<ver>`);
 *   - a memo under the SAME stamp is honoured (read path uses the same key);
 *   - a memo under ANOTHER build's stamp is ignored (fresh resolution wins);
 *   - two different stamps mint two different keys.
 *
 * buildInfo reads APP_BUILD_SHA once at require time, so scenarios that need a
 * specific stamp evict middleware.js + buildInfo.js and reload them (same
 * pattern as utils/buildInfo.test.js).
 *
 * Run: cd server && node --test --test-force-exit license/middleware.cacheStamp.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const license = require('./index');
const MIDDLEWARE = require.resolve('./middleware');
const BUILDINFO = require.resolve('../utils/buildInfo');

// Keep the resolver away from the (absent) DB: the super-admin path below
// still probes the personal tier first. Monkeypatched on the shared module
// object, so every fresh middleware load sees it.
const realResolveTier = license.resolveTier;
license.resolveTier = async () => 'community';
after(() => { license.resolveTier = realResolveTier; });

function freshMiddleware(sha) {
    delete require.cache[MIDDLEWARE];
    delete require.cache[BUILDINFO];
    process.env.APP_BUILD_SHA = sha;
    try {
        return require(MIDDLEWARE);
    } finally {
        delete process.env.APP_BUILD_SHA;
        delete require.cache[MIDDLEWARE];
        delete require.cache[BUILDINFO];
    }
}

function adminReq(userId, extraSessionEntries = {}) {
    // Super-admin: resolves via the DB-free bypass (tier 'full') and still
    // exercises both the memo read (before the bypass) and the memo write.
    return {
        session: {
            isAuthenticated: true,
            isAdmin: true,
            user: { id: userId, role: 'admin', organizationId: null },
            ...extraSessionEntries,
        },
    };
}

test('the memo is written under the build-stamped key', async () => {
    const mw = freshMiddleware('stamp-a');
    const req = adminReq('u1');
    const out = await mw.resolveBestTierForRequest(req);
    assert.equal(out.tier, 'full');

    const ver = license.getServerLicenseVersion();
    const licKeys = Object.keys(req.session).filter(k => k.startsWith('_lic:'));
    assert.deepEqual(licKeys, [`_lic:u1:v${ver}:bstamp-a`]);
});

test('a memo under the SAME stamp is honoured on the read path', async () => {
    const mw = freshMiddleware('stamp-a');
    const ver = license.getServerLicenseVersion();
    const sentinel = { tier: 'sentinel-tier', orgIds: [], userTier: 'sentinel-tier', orgTiers: {}, spread: null };
    const req = adminReq('u2', {
        [`_lic:u2:v${ver}:bstamp-a`]: { expiresAt: Date.now() + 60_000, value: sentinel },
    });
    const out = await mw.resolveBestTierForRequest(req);
    assert.equal(out.tier, 'sentinel-tier', 'cache read happens before any resolution — the primed memo must win');
});

test('a memo under ANOTHER build\'s stamp is ignored (rolling-deploy isolation)', async () => {
    const mw = freshMiddleware('stamp-a');
    const ver = license.getServerLicenseVersion();
    // The "other pod" cached community for this admin. If the stamp were not
    // part of the key, this stale foreign memo would be served verbatim.
    const foreign = { tier: 'community', orgIds: [], userTier: 'community', orgTiers: {}, spread: null };
    const req = adminReq('u3', {
        [`_lic:u3:v${ver}:bother-build`]: { expiresAt: Date.now() + 60_000, value: foreign },
    });
    const out = await mw.resolveBestTierForRequest(req);
    assert.equal(out.tier, 'full', 'the foreign memo must be a miss — fresh resolution wins');
    // ...and this build wrote its own key next to the foreign one.
    assert.ok(req.session[`_lic:u3:v${ver}:bstamp-a`], 'own stamped memo must be written');
});

test('two different build stamps mint two different keys', async () => {
    const runWith = async (sha) => {
        const mw = freshMiddleware(sha);
        const req = adminReq('u4');
        await mw.resolveBestTierForRequest(req);
        return Object.keys(req.session).find(k => k.startsWith('_lic:'));
    };
    const keyA = await runWith('sha-old');
    const keyB = await runWith('sha-new');
    assert.ok(keyA.endsWith(':bsha-old'), keyA);
    assert.ok(keyB.endsWith(':bsha-new'), keyB);
    assert.notEqual(keyA, keyB);
});
