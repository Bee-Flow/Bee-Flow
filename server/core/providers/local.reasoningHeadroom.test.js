/**
 * A thinking turn against a self-hosted runtime keeps room to answer.
 *
 * These runtimes spend reasoning tokens from the SAME budget as the answer
 * (llama.cpp counts them in n_predict; Ollama and vLLM likewise), while a
 * tier's maxTokens was sized for the visible answer alone. Measured on the demo
 * box 2026-09-12 (Gemma 4 26B-A4B behind llama-server, --reasoning-budget
 * 2048): a 600-token ceiling with thinking on returned content: '' and no
 * tool_calls on 2 of 6 tool cases — the model had reasoned 190 and 227 words
 * and been cut off before it could emit anything. Raising the ceiling alone
 * turned both into correct tool calls. Nothing on the local path retries an
 * empty turn (the retry in directChat/finalizeTurn is gated on /claude/i), so
 * the ceiling is the whole defence.
 *
 * Run: cd server && node --test --test-force-exit core/providers/local.reasoningHeadroom.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const LocalProvider = require('./local');

const MESSAGES = [{ role: 'user', content: 'Plan a meeting with Tom and Lisa on Monday at 10:00.' }];

/** max_tokens as it would go out on the wire. */
function ceilingFor(flavor, options) {
    const provider = new LocalProvider(flavor);
    return provider.buildRequestBody('gemma-4-26b-a4b', MESSAGES, options).max_tokens;
}

test('a ceiling too small to think AND answer is raised', () => {
    // fast-tier shape: 2048 total, medium effort. 2048 reasoning + 1024 answer.
    const out = ceilingFor('llamacpp', { maxTokens: 2048, reasoningEffort: 'medium', _runtime: 'llamacpp' });
    assert.strictEqual(out, 3072);
});

test('a ceiling that already has room is left exactly as configured', () => {
    // thinking-tier shape: the tier is authoritative when it is comfortable,
    // so a deployment that tuned its ceilings sees no change.
    const out = ceilingFor('llamacpp', { maxTokens: 8192, reasoningEffort: 'medium', _runtime: 'llamacpp' });
    assert.strictEqual(out, 8192);
});

test('effort scales the reserve', () => {
    const low = ceilingFor('llamacpp', { maxTokens: 512, reasoningEffort: 'low', _runtime: 'llamacpp' });
    const medium = ceilingFor('llamacpp', { maxTokens: 512, reasoningEffort: 'medium', _runtime: 'llamacpp' });
    const high = ceilingFor('llamacpp', { maxTokens: 512, reasoningEffort: 'high', _runtime: 'llamacpp' });
    assert.ok(low < medium && medium < high, `expected low < medium < high, got ${low} ${medium} ${high}`);
    assert.strictEqual(low, 2048);
    assert.strictEqual(high, 5120);
});

test('an explicit budget wins over the effort ladder', () => {
    const out = ceilingFor('llamacpp', { maxTokens: 512, reasoningEffort: 'low', budgetTokens: 6000, _runtime: 'llamacpp' });
    assert.strictEqual(out, 7024);
});

test('thinking off leaves the ceiling alone', () => {
    // The tier said "none": no reasoning is coming, so nothing is reserved and
    // a tight ceiling stays tight.
    const out = ceilingFor('llamacpp', { maxTokens: 2048, reasoningEffort: 'none', _runtime: 'llamacpp' });
    assert.strictEqual(out, 2048);
});

test('budgetTokens 0 means no thinking, so no headroom', () => {
    // Title generation / classification pass this. It must stay cheap.
    const out = ceilingFor('llamacpp', { maxTokens: 64, reasoningEffort: 'medium', budgetTokens: 0, _runtime: 'llamacpp' });
    assert.strictEqual(out, 64);
});

test('no stated preference leaves the ceiling alone', () => {
    // _resolveThinking returns null here and we send no thinking switch at all,
    // so whether the server reasons is its own default to make — guessing a
    // reserve would silently widen every ceiling on every deployment.
    const out = ceilingFor('llamacpp', { maxTokens: 2048, _runtime: 'llamacpp' });
    assert.strictEqual(out, 2048);
});

test('the reserve applies to every self-hosted flavour, not just llama.cpp', () => {
    // Ollama and vLLM count reasoning against the same budget; the fix must not
    // be tied to the one runtime it was measured on.
    for (const flavor of ['ollama', 'vllm', 'lmstudio', 'sglang']) {
        const out = ceilingFor(flavor, { maxTokens: 1024, reasoningEffort: 'medium' });
        assert.strictEqual(out, 3072, `${flavor} did not reserve reasoning headroom`);
    }
});

test('extraBody still overrides the ceiling', () => {
    // The documented escape hatch in buildRequestBody: a caller who insists
    // wins over everything the adapter decided.
    const out = ceilingFor('llamacpp', {
        maxTokens: 512, reasoningEffort: 'high', _runtime: 'llamacpp',
        extraBody: { max_tokens: 777 },
    });
    assert.strictEqual(out, 777);
});

test('a missing ceiling falls through to BaseProvider default, unharmed', () => {
    const out = ceilingFor('llamacpp', { reasoningEffort: 'medium', _runtime: 'llamacpp' });
    assert.strictEqual(out, 8192);
});
