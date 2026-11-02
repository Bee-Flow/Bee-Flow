'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkWebhookSignature, hmacHeader } = require('./webhookSignature');

const secret = 's3cret';
const nonce = 'n-1';
const body = { order: '1042', status: 'paid' };
const compact = JSON.stringify(body);
const pretty = JSON.stringify(body, null, 2);
const NOW = 1_800_000_000_000;

test('the request bytes are what is signed; the rebuilt JSON form stays accepted for older senders', () => {
    const overPretty = hmacHeader(secret, `${nonce}\n${pretty}`);
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: overPretty, nonce, rawBody: pretty, body }), { ok: true });
    const overCompact = hmacHeader(secret, `${nonce}\n${compact}`);
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: overCompact, nonce, rawBody: pretty, body }), { ok: true });
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: overCompact, nonce, body }), { ok: true });
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: hmacHeader('other', `${nonce}\n${compact}`), nonce, body }), { ok: false, reason: 'bad_signature' });
});

test('a timestamp joins the signed text and must be within five minutes', () => {
    const ts = String(Math.floor(NOW / 1000) - 60);
    const sig = hmacHeader(secret, `${nonce}\n${ts}\n${compact}`);
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: sig, nonce, timestamp: ts, rawBody: compact, body, now: NOW }), { ok: true });
    // The same signature without the timestamp header does not verify: the header is part of the message.
    assert.equal(checkWebhookSignature({ secret, sigHeader: sig, nonce, rawBody: compact, body, now: NOW }).ok, false);
    const old = String(Math.floor(NOW / 1000) - 301);
    const oldSig = hmacHeader(secret, `${nonce}\n${old}\n${compact}`);
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: oldSig, nonce, timestamp: old, rawBody: compact, body, now: NOW }), { ok: false, reason: 'stale_timestamp' });
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: sig, nonce, timestamp: 'yesterday', rawBody: compact, body, now: NOW }), { ok: false, reason: 'stale_timestamp' });
});

test('a missing header or nonce is refused before any crypto runs', () => {
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: '', nonce, body }), { ok: false, reason: 'missing' });
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: 'md5=abc', nonce, body }), { ok: false, reason: 'missing' });
    assert.deepEqual(checkWebhookSignature({ secret, sigHeader: hmacHeader(secret, `\n${compact}`), nonce: '', body }), { ok: false, reason: 'missing' });
});
