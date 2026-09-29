// @typecheck
/**
 * The Mistral client for Voxtral transcription, built in one place.
 *
 * Four call sites each built it with `{ apiKey, timeout }`. The SDK's option
 * is `timeoutMs`; `timeout` is not read, so VOXTRAL_TIMEOUT_MS (default 30
 * minutes, sized for long recordings) never applied and the SDK's own default
 * did. The server typecheck found it.
 *
 * SDK v2: the options and `audio.transcriptions.complete` are unchanged from
 * 1.x. v2's own default timeout is 300 s, which is why passing ours matters
 * even more now — a long recording would otherwise be cut at five minutes.
 */
'use strict';

/** Milliseconds a transcription request may take; VOXTRAL_TIMEOUT_MS overrides. */
function voxtralTimeoutMs(env = process.env) {
    return Number(env.VOXTRAL_TIMEOUT_MS) || 1_800_000;
}

/**
 * @param {string} apiKey
 * @param {{ timeoutMs?: number }} [options]
 */
function createVoxtralClient(apiKey, { timeoutMs = voxtralTimeoutMs() } = {}) {
    const { Mistral } = require('@mistralai/mistralai');
    // No SDK retries (also its default, stated so it stays that way): a
    // transcription upload is large and the callers decide about a retry.
    return new Mistral({ apiKey, timeoutMs, retryConfig: { strategy: 'none' } });
}

module.exports = { createVoxtralClient, voxtralTimeoutMs };
