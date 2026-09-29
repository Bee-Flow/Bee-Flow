/**
 * A builder round against a self-hosted runtime cannot run unbounded.
 *
 * Both builder routes called the adapter with no `timeoutMs` and no `signal`.
 * A cloud provider fails a wedged request for us; llama.cpp does not, and
 * `clientGone` is only read at the TOP of the next iteration — so a closed tab
 * still generated the CURRENT round to the max_tokens cap, on a box whose model
 * has one slot. Measured on the demo box 2026-09-13/14: 17 builder rounds ran
 * to the 8192 cap, the longest for 395 s.
 *
 * core/agentRuntime/chatStream.js already does this for the same adapter; these
 * pin the same guarantee for the builders, centrally, so a third builder gets
 * it for free.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/builderShared.streamGuards.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { streamWithRetry } = require('./builderShared');

/** An adapter that records the options it was handed and ends the stream. */
function recordingAdapter(seen) {
    return {
        async stream(_key, _url, _model, _messages, options, onEvent) {
            seen.push(options);
            onEvent('text', { text: 'ok' });
            onEvent('done', { stop_reason: 'stop', prompt_tokens: 1, completion_tokens: 1 });
        },
    };
}

const NOOP_OPTS = {
    send: () => {},
    emitThinking: { start: () => {}, delta: () => {}, stop: () => {} },
};

async function run(cfg, options, extra = {}) {
    const seen = [];
    await streamWithRetry(recordingAdapter(seen), cfg, 'm', [], options, { ...NOOP_OPTS, ...extra });
    return seen[0];
}

test('a local runtime gets a stall watchdog even when the route asks for none', async () => {
    const opts = await run({ providerType: 'llamacpp', url: 'http://x/v1' }, { maxTokens: 10 });
    assert.strictEqual(opts.timeoutMs, 120000);
});

test('every self-hosted flavour is covered, not just llama.cpp', async () => {
    for (const providerType of ['ollama', 'vllm', 'lmstudio', 'sglang', 'openai-compatible']) {
        const opts = await run({ providerType, url: 'http://x/v1' }, {});
        assert.strictEqual(opts.timeoutMs, 120000, `${providerType} ran without a watchdog`);
    }
});

test('a cloud provider is left exactly as it was — its own API fails a wedged call', async () => {
    const opts = await run({ providerType: 'claude', url: 'https://api.anthropic.com/v1' }, { maxTokens: 10 });
    assert.strictEqual(opts.timeoutMs, undefined);
    assert.strictEqual(opts.maxTokens, 10);
});

test('the client disconnect signal reaches the adapter, local or not', async () => {
    const ac = new AbortController();
    for (const providerType of ['llamacpp', 'claude']) {
        const opts = await run({ providerType, url: 'http://x/v1' }, {}, { signal: ac.signal });
        assert.strictEqual(opts.signal, ac.signal, `${providerType} lost the abort signal`);
    }
});

test('a route that sets its own ceiling keeps it', async () => {
    // Defaults, not overrides: a caller who knows better than the shared
    // number must win, or this helper becomes a policy nobody can escape.
    const opts = await run({ providerType: 'llamacpp', url: 'http://x/v1' }, { timeoutMs: 5000 });
    assert.strictEqual(opts.timeoutMs, 5000);
});

test('the round options themselves are passed through untouched', async () => {
    const opts = await run({ providerType: 'llamacpp', url: 'http://x/v1' },
        { maxTokens: 8192, temperature: 0.4, tools: [{ a: 1 }], toolChoice: 'required' });
    assert.strictEqual(opts.maxTokens, 8192);
    assert.strictEqual(opts.temperature, 0.4);
    assert.strictEqual(opts.toolChoice, 'required');
    assert.deepStrictEqual(opts.tools, [{ a: 1 }]);
});
