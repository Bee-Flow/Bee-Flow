// @typecheck strict
/**
 * What counts as "proved who they are a moment ago" (auth/recentAuth.js).
 *
 * Run: cd server && node --test auth/recentAuth.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { hasRecentAuth, RECENT_AUTH_MAX_AGE_MS, REAUTH_REQUIRED } = require('./recentAuth');

const NOW = 1_700_000_000_000;

test('a session with no mark at all has no recent proof', () => {
    assert.strictEqual(hasRecentAuth({}, NOW), false);
    assert.strictEqual(hasRecentAuth(null, NOW), false);
    assert.strictEqual(hasRecentAuth(undefined, NOW), false);
});

test('each kind of proof counts, on its own, inside the window', () => {
    for (const mark of ['authenticatedAt', 'mfaVerifiedAt', 'opaqueLoginAt', 'pinVerifiedAt']) {
        assert.strictEqual(hasRecentAuth({ [mark]: NOW - 60_000 }, NOW), true, mark);
        assert.strictEqual(hasRecentAuth({ [mark]: NOW - RECENT_AUTH_MAX_AGE_MS }, NOW), true, `${mark} at the edge`);
        assert.strictEqual(hasRecentAuth({ [mark]: NOW - RECENT_AUTH_MAX_AGE_MS - 1 }, NOW), false, `${mark} just past`);
    }
});

test('the newest proof is what counts: an old sign-in with a fresh second factor passes', () => {
    assert.strictEqual(hasRecentAuth({ authenticatedAt: NOW - 86_400_000, mfaVerifiedAt: NOW - 1000 }, NOW), true);
});

test('a mark from the future or of the wrong type is not a proof', () => {
    assert.strictEqual(hasRecentAuth({ authenticatedAt: NOW + 1000 }, NOW), false);
    assert.strictEqual(hasRecentAuth({ authenticatedAt: String(NOW) }, NOW), false);
    assert.strictEqual(hasRecentAuth({ authenticatedAt: true }, NOW), false);
});

test('the window is ten minutes and the refusal names its code', () => {
    assert.strictEqual(RECENT_AUTH_MAX_AGE_MS, 10 * 60 * 1000);
    assert.strictEqual(REAUTH_REQUIRED.status, 403);
    assert.strictEqual(REAUTH_REQUIRED.body.code, 'reauth_required');
});
