/**
 * Run: cd server && node --test appStudio/mailboxProviderFailure.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { providerFailure, materializeErrorBody } = require('./mailboxProviderFailure.mts');

test('an error of our own is returned as is', () => {
    const own = Object.assign(new Error('too large'), { status: 413 });
    assert.strictEqual(providerFailure(own, 'outlook'), own);
    assert.strictEqual(providerFailure(null, 'outlook'), null);
});

test('a googleapis error is recognised by its response', () => {
    const gmail = Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
    const out = providerFailure(gmail, 'gmail');
    assert.strictEqual(out.status, 404);
    assert.strictEqual(out.code, 'attachment_gone');
});

test('the response body shows a viewer-facing message even on a 5xx, and nothing else does', () => {
    const exposed = providerFailure(Object.assign(new Error('Graph API 400: {}'), { status: 400, graphCode: 'BadRequest' }), 'outlook');
    assert.deepStrictEqual(materializeErrorBody(exposed, 502), {
        error: 'The mail provider could not deliver this attachment.', code: 'provider_error',
    });
    assert.deepStrictEqual(materializeErrorBody(new Error('db down: secret detail'), 500), { error: 'Failed to open attachment' });
    assert.deepStrictEqual(materializeErrorBody(Object.assign(new Error('Not found'), { status: 404 }), 404), { error: 'Not found' });
});
