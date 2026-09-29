/**
 * Regression — non-streaming reasoning chat must not trip the SDK's
 * "Streaming is required for operations that may take longer than 10 minutes"
 * pre-flight guard.
 *
 * The @anthropic-ai/sdk `messages.create` throws that error SYNCHRONOUSLY (before
 * any network call) for a non-streaming request when the client was built with
 * no explicit `timeout` AND max_tokens clears the guard ceiling — either the
 * time-based limit (max_tokens > ~21333) or a per-model cap (Opus 4/4.1
 * non-streaming = 8192). Adaptive thinking bumps max_tokens to 16384, so any
 * reasoning-capable Opus-4/4.1 non-streaming chat() hit it. That surfaced as the
 * Support auto-responder escalating every ticket:
 *   "AI auto-responder failed (Streaming is required…). Escalated to staff."
 *
 * Fix: createClient() passes an explicit `timeout`, which disables the guard.
 *
 * Run: node --test core/providers/claudeNonstreamingTimeout.test.js
 */

const assert = require('assert');
const { test } = require('node:test');
const Anthropic = require('@anthropic-ai/sdk');
const ClaudeProvider = require('./claude');

const p = new ClaudeProvider();
const MSGS = [{ role: 'user', content: 'hi' }];
const GUARD_RE = /Streaming is required for operations that may take longer than 10 minutes/;

// The guard has TWO triggers, and only one of them still bites:
//
//   1. A per-model non-streaming cap (Opus 4/4.1 = 8192). This is what the
//      original bug hit — adaptive thinking bumps max_tokens to 16384, which
//      cleared Opus 4.1's cap. @anthropic-ai/sdk 0.116.0 REMOVED the retired
//      Opus 4.1 models from its table, so that shape no longer trips the guard
//      at all and a 16384 baseline assertion became vacuous: it passed with or
//      without our fix, quietly protecting nothing.
//
//   2. A time-based limit (roughly max_tokens > 21333), which is very much
//      still live — and which our own `deep_thinking` tier walks straight into
//      at 64000 (see TIER_DEFAULTS in core/llm/modelResolver.js).
//
// So the canary now uses trigger 2, on a current model. If this baseline test
// ever stops throwing again, the SDK changed underneath us and the workaround
// in createClient() needs re-checking — that is the whole point of it.
const DEEP_THINKING_MAX_TOKENS = 64000;

function guardTrippingParams() {
    const params = p._buildSdkParams('claude-opus-5', MSGS, {
        reasoningEffort: 'high',
        maxTokens: DEEP_THINKING_MAX_TOKENS,
    });
    assert.strictEqual(params.max_tokens, DEEP_THINKING_MAX_TOKENS,
        'deep_thinking max_tokens should reach the SDK unchanged');
    assert.strictEqual(params.temperature, undefined,
        'Opus 5 is adaptive-only and must never be sent a temperature');
    params.stream = false;
    return params;
}

test('baseline: a no-timeout client throws the guard for these params (locks in the SDK behaviour we work around)', () => {
    const bare = new Anthropic({ apiKey: 'sk-test-not-real' });
    assert.throws(() => bare.messages.create(guardTrippingParams()), GUARD_RE);
});

test('createClient() builds a client that does NOT throw the guard for the same params', () => {
    const client = p.createClient('sk-test-not-real');
    // The guard throws synchronously; the fix means create() returns its promise
    // instead. Swallow the eventual network/auth rejection — we only assert the
    // synchronous guard is gone, not that the (fake-key) request succeeds.
    let pending;
    assert.doesNotThrow(() => { pending = client.messages.create(guardTrippingParams()); });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
});

test('createClient() sets the effective timeout to the SDK default (unchanged request behaviour)', () => {
    const client = p.createClient('sk-test-not-real');
    assert.strictEqual(client.timeout, 600000);
});
