/**
 * The Voxtral client gets its timeout under the option name the Mistral SDK
 * reads (`timeoutMs`). The four call sites used to pass `timeout`, which the
 * SDK ignores, so a 30-minute recording limit silently became the default.
 *
 * Run: cd server && node --test core/meetingNotes/voxtralClient.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createVoxtralClient, voxtralTimeoutMs } = require('./voxtralClient');

test('the timeout reaches the SDK', () => {
    const client = createVoxtralClient('key', { timeoutMs: 1234 });
    assert.strictEqual(client._options.timeoutMs, 1234);
});

test('the SDK does not retry a transcription upload on its own', () => {
    assert.deepStrictEqual(createVoxtralClient('key')._options.retryConfig, { strategy: 'none' });
});

test('by default it is VOXTRAL_TIMEOUT_MS, or 30 minutes', () => {
    assert.strictEqual(voxtralTimeoutMs({ VOXTRAL_TIMEOUT_MS: '60000' }), 60000);
    assert.strictEqual(voxtralTimeoutMs({}), 1_800_000);
    assert.strictEqual(voxtralTimeoutMs({ VOXTRAL_TIMEOUT_MS: 'soon' }), 1_800_000);
    assert.strictEqual(createVoxtralClient('key')._options.timeoutMs, voxtralTimeoutMs());
});
