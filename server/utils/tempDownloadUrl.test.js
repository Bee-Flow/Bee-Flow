/**
 * HMAC-signed temp download URLs: round trip, and "anything that is not a
 * currently-valid temp URL" answers null (never throws).
 *
 * Run: cd server && node --test utils/tempDownloadUrl.test.js
 */

'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(48);

const { test } = require('node:test');
const assert = require('node:assert');

const { generateTempDownloadUrl, resolveTempDownloadKey, verifyTempSignature } = require('./tempDownloadUrl');

const KEY = 'users/u1/uploads/cat.png';

test('a generated URL resolves back to its key', () => {
    assert.strictEqual(resolveTempDownloadKey(generateTempDownloadUrl(KEY)), KEY);
});

test('a tampered token or key resolves to null', () => {
    const url = new URL(generateTempDownloadUrl(KEY));
    const other = new URL(url);
    other.searchParams.set('key', 'users/u2/uploads/cat.png');
    assert.strictEqual(resolveTempDownloadKey(other.toString()), null);
    assert.strictEqual(resolveTempDownloadKey(url.toString().replace(/tmp\/[0-9a-f]{4}/, 'tmp/zzzz')), null);
});

test('a malformed percent escape in the token is "not a temp URL", not a thrown URIError', () => {
    const expires = Math.floor(Date.now() / 1000) + 60;
    const url = `https://host/api/storage/tmp/%E0%A4%A?key=${encodeURIComponent(KEY)}&expires=${expires}`;
    assert.doesNotThrow(() => resolveTempDownloadKey(url));
    assert.strictEqual(resolveTempDownloadKey(url), null);
});

test('an expired signature is refused', () => {
    assert.strictEqual(verifyTempSignature(KEY, Math.floor(Date.now() / 1000) - 5, 'ab'), 'expired');
});
