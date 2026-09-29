/**
 * Local adapter — llama-server prefill progress is requested only where it is
 * understood.
 *
 * `return_progress: true` makes llama-server stream `prompt_progress` chunks
 * while it reads the prompt: the only live measurement of a 200 s first-round
 * prefill on the demo box. It is a llama.cpp-only field — Ollama and vLLM do
 * not know it and a strict OpenAI-shaped server answers an unknown key with a
 * 400 — so it rides the same runtime gate as `reasoning_effort`, and only on a
 * streamed request (the non-streaming chat path has nothing to show it on).
 *
 * Pure: buildRequestBody only, no network.
 * Run: cd server && node --test --test-force-exit core/providers/local.progress.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const LocalProvider = require('./local');

const MSGS = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }];

test('llamacpp flavor + streaming → return_progress: true', () => {
    const body = new LocalProvider('llamacpp').buildRequestBody('qwen3-27b', MSGS, { stream: true });
    assert.strictEqual(body.return_progress, true);
    assert.strictEqual(body.stream, true);
    // The sibling streaming-only field still rides along — same gate.
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
});

test('a generic flavor whose runtime was detected as llama.cpp (_runtime) also asks for progress', () => {
    const body = new LocalProvider('openai-compatible').buildRequestBody('m', MSGS, { stream: true, _runtime: 'llamacpp' });
    assert.strictEqual(body.return_progress, true);
});

test('the non-streaming chat path never sends it', () => {
    const body = new LocalProvider('llamacpp').buildRequestBody('m', MSGS, { stream: false });
    assert.strictEqual(body.return_progress, undefined);
    assert.strictEqual(body.stream_options, undefined, 'mirrors stream_options: nothing stream-only without a stream');
    const noStreamOpt = new LocalProvider('llamacpp').buildRequestBody('m', MSGS, {});
    assert.strictEqual(noStreamOpt.return_progress, undefined, 'stream unset (base leaves body.stream undefined) → no progress');
});

test('Ollama, vLLM, LM Studio, SGLang and an unknown runtime never see the field', () => {
    for (const flavor of ['ollama', 'vllm', 'lmstudio', 'sglang', 'openai-compatible']) {
        const body = new LocalProvider(flavor).buildRequestBody('m', MSGS, { stream: true });
        assert.strictEqual(body.return_progress, undefined, flavor);
        assert.ok(!('return_progress' in body), `${flavor}: key must be absent, not false`);
    }
    // A generic flavor probed as 'other' stays clean too.
    const other = new LocalProvider('openai-compatible').buildRequestBody('m', MSGS, { stream: true, _runtime: 'other' });
    assert.ok(!('return_progress' in other));
});

test('extraBody still wins — an operator can switch it off per request', () => {
    const body = new LocalProvider('llamacpp').buildRequestBody('m', MSGS, { stream: true, extraBody: { return_progress: false } });
    assert.strictEqual(body.return_progress, false);
});

test('reasoning settings do not change the answer (the gate is runtime + stream, nothing else)', () => {
    for (const opts of [{ reasoningEffort: 'high' }, { reasoningEffort: 'none' }, { budgetTokens: 0 }, {}]) {
        const body = new LocalProvider('llamacpp').buildRequestBody('m', MSGS, { stream: true, ...opts });
        assert.strictEqual(body.return_progress, true, JSON.stringify(opts));
    }
});
