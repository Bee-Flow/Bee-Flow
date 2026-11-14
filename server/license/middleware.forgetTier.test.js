// @typecheck
/**
 * forgetTierResolution: the request that activates or removes a licence drops
 * its own session's memo of the resolved tier, so its next gated request sees
 * the new tier instead of the old one for up to the cache TTL.
 *
 * Run: cd server && node --test license/middleware.forgetTier.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forgetTierResolution } = require('./middleware');

test('drops every tier memo of the signed-in user, whatever its build and version stamp', () => {
    const session = {
        user: { id: 'u1' },
        'b1:_lic:u1:v3': { expiresAt: Date.now() + 30_000, value: { tier: 'community' } },
        'b2:_lic:u1:v4': { expiresAt: Date.now() + 30_000, value: { tier: 'community' } },
        '_lic:u2:v3': { expiresAt: Date.now() + 30_000, value: { tier: 'pro' } },
        other: 'kept',
    };
    forgetTierResolution({ session });
    assert.deepEqual(Object.keys(session).sort(), ['_lic:u2:v3', 'other', 'user']);
});

test('without a session or a signed-in user it does nothing', () => {
    assert.doesNotThrow(() => forgetTierResolution({}));
    const session = { '_lic:u1:v1': {} };
    forgetTierResolution({ session });
    assert.deepEqual(Object.keys(session), ['_lic:u1:v1']);
});
