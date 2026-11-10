/**
 * The installation's Google OAuth client: configured means id AND secret, and
 * the configured check answers a boolean, never the values themselves. The
 * auth config comes in through the loader parameter, no module mocking.
 *
 * Run: cd server && node --test auth/googleOAuthConfig.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { getGoogleClientConfig, isGoogleConfigured } = require('./googleOAuthConfig');

/** @param {Record<string, string> | undefined} google */
const loaderFor = (google) => async () => ({ providers: google === undefined ? {} : { google } });

test('configured: id and secret set → true, as a plain boolean', async () => {
    const configured = await isGoogleConfigured(loaderFor({ clientId: 'cid-123', clientSecret: 'shh-456' }));
    assert.strictEqual(configured, true);
    assert.strictEqual(typeof configured, 'boolean', 'nothing of the client travels with the answer');
});

test('not configured: no Google provider, or only one of the two → false', async () => {
    for (const google of [undefined, {}, { clientId: 'cid-123' }, { clientSecret: 'shh-456' }, { clientId: '', clientSecret: '' }]) {
        assert.strictEqual(await isGoogleConfigured(loaderFor(google)), false, JSON.stringify(google));
    }
    assert.strictEqual(await isGoogleConfigured(async () => ({})), false, 'no providers block at all');
});

test('getGoogleClientConfig: empty strings for what is unset', async () => {
    assert.deepStrictEqual(await getGoogleClientConfig(loaderFor(undefined)), { clientId: '', clientSecret: '' });
    assert.deepStrictEqual(
        await getGoogleClientConfig(loaderFor({ clientId: 'cid-123', clientSecret: 'shh-456' })),
        { clientId: 'cid-123', clientSecret: 'shh-456' },
    );
});

test('an unreadable auth config rejects; callers decide the fallback', async () => {
    await assert.rejects(isGoogleConfigured(async () => { throw new Error('auth config unreadable'); }), /auth config unreadable/);
});
