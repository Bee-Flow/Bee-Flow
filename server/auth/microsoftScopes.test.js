/**
 * Microsoft scopes live in ONE place.
 *
 * The scope string was copied into three files; a refresh that re-requests a
 * narrower set than was granted silently downgrades the token, so the copies
 * drifting apart meant grants quietly losing capabilities. These tests keep the
 * single source honest and keep the refresh from narrowing a wider grant.
 *
 * Run: cd server && node --test auth/microsoftScopes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { MICROSOFT_SCOPES, microsoftRefreshScope, OAUTH_PROVIDERS } = require('./permissions');

test('the provider config uses the shared scope list', () => {
    assert.strictEqual(OAUTH_PROVIDERS.microsoft.scopes, MICROSOFT_SCOPES);
});

test('the login scope set still covers mail read + send', () => {
    // The whole mailbox capability rides on the SSO grant; losing either of
    // these breaks reading and replying for every Microsoft user.
    assert.ok(MICROSOFT_SCOPES.includes('Mail.Read'));
    assert.ok(MICROSOFT_SCOPES.includes('Mail.Send'));
    assert.ok(MICROSOFT_SCOPES.includes('offline_access'), 'no refresh token without offline_access');
});

test('refresh falls back to the default set when nothing was recorded', () => {
    const expected = MICROSOFT_SCOPES.join(' ');
    assert.strictEqual(microsoftRefreshScope(undefined), expected);
    assert.strictEqual(microsoftRefreshScope(null), expected);
    assert.strictEqual(microsoftRefreshScope(''), expected);
    assert.strictEqual(microsoftRefreshScope('   '), expected);
    assert.strictEqual(microsoftRefreshScope(42), expected, 'a non-string must not leak into the request');
});

test('refresh preserves a WIDER granted scope', () => {
    // The case that matters: a user consented to shared-mailbox scopes through
    // an integration connect flow. The refresh must not strip them back to the
    // login set.
    const granted = 'openid profile email User.Read Mail.Read Mail.Send Mail.Read.Shared Mail.Send.Shared offline_access';
    assert.strictEqual(microsoftRefreshScope(granted), granted);
    assert.match(microsoftRefreshScope(granted), /Mail\.Read\.Shared/);
});

test('no file re-declares the Microsoft scope string', () => {
    // Guards the de-duplication itself: a future copy-paste fails here.
    // Kept as source text on purpose: three of these four sites already call
    // microsoftRefreshScope()/OAUTH_PROVIDERS today (covered behaviourally by
    // the tests above), so a spy on that call would only prove today's wiring
    // — it would miss a hardcoded scope literal added ALONGSIDE the call, which
    // is exactly the copy-paste this test exists to catch. The property is "no
    // second copy of this string anywhere in the file", which has no call to
    // make and observe.
    const serverDir = path.join(__dirname, '..');
    const suspects = [
        'auth/routineAuth.js',
        'integrations/msGraphClient.js',
        'auth/oauth/providerLoginRoutes.js',
        'auth/oauth/providerCallbackRoutes.js',
    ];
    for (const rel of suspects) {
        const src = fs.readFileSync(path.join(serverDir, rel), 'utf8');
        assert.doesNotMatch(
            src,
            /'openid email profile User\.Read Mail\.Read/,
            `${rel} must use microsoftRefreshScope(), not its own scope literal`,
        );
    }
});
