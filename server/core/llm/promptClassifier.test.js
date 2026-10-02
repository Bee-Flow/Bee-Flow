/**
 * Unit tests for the prompt classifier's LLM stage.
 *
 * Covers the claude-sonnet-5 regression where adaptive thinking leaked
 * reasoning prose into the text channel and the whitespace-stripping
 * normalizer turned it into an unmatchable token:
 *   - the classify call must disable thinking (reasoningEffort 'none'),
 *   - a verbose reply is salvaged via last-whole-word tier extraction,
 *   - garbage/failed replies fall back to the heuristic AND get cached so
 *     forEach re-runs stop re-hitting the LLM.
 *
 * Heavy deps are pre-mocked via the require cache (same approach as
 * automationRunner.aistep.test.js).
 *
 * Run: node --test core/promptClassifier.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Captured chat calls from the mocked llmClient.
let chatCalls = [];
let nextContent = 'fast';
let nextError = null;
let nextHang = false;

// Short LLM deadline so the "never answers" case finishes fast.
process.env.AUTO_TIER_LLM_DEADLINE_MS = '50';

// classify-service stage: no opinion unless a test says otherwise, so the
// suite never reaches a real service even when CLASSIFY_SERVICE_URL is set.
let serviceCalls = [];
let nextServiceVerdict = null;
mock('./tierClassifierService', {
    classifyTierViaService: async (text, tiers, opts) => {
        serviceCalls.push({ text, tiers, opts });
        return nextServiceVerdict;
    },
});

mock('../../stores/configStore', { getConfig: async () => null });
mock('./llmClient', {
    chat: async (modelId, messages, options) => {
        chatCalls.push({ modelId, messages, options });
        if (nextHang) return new Promise(() => {});
        if (nextError) throw nextError;
        return { content: nextContent, usage: {} };
    },
});

const {
    classifyWithLLM,
    clearClassifierCache,
    extractTierWord,
    classifyPromptComplexity,
} = require('./promptClassifier');

const TIERS = {
    fast: { modelId: 'model-fast' },
    thinking: { modelId: 'model-thinking' },
    deep_thinking: { modelId: 'model-deep' },
};

// Ambiguous plain prose (> 12 chars, no code/math/URL/list/question signals)
// so the pipeline reaches the LLM stage instead of the heuristic shortcut.
const AMBIGUOUS_MSG = 'Extract the invoice number and the total amount from the email body';

function reset({ content = 'fast', error = null, hang = false, service = null } = {}) {
    chatCalls = [];
    serviceCalls = [];
    nextContent = content;
    nextError = error;
    nextHang = hang;
    nextServiceVerdict = service;
    clearClassifierCache();
}

test('ambiguous message actually reaches the LLM stage', () => {
    const h = classifyPromptComplexity(AMBIGUOUS_MSG);
    assert.strictEqual(h.confident, false);
});

test('classify call disables thinking (reasoningEffort none, budgetTokens 0)', async () => {
    reset({ content: 'fast' });
    const out = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(out.tier, 'fast');
    assert.strictEqual(out.method, 'llm');
    assert.strictEqual(chatCalls.length, 1);
    const opts = chatCalls[0].options;
    assert.strictEqual(opts.reasoningEffort, 'none');
    assert.strictEqual(opts.budgetTokens, 0);
    assert.strictEqual(opts.maxTokens, 8);
});

test('clean one-word reply still resolves via the strict path', async () => {
    reset({ content: '  Thinking.\n' });
    const out = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(out.tier, 'thinking');
    assert.strictEqual(out.method, 'llm');
});

test('verbose reasoning prose ending in the answer word is salvaged', async () => {
    reset({
        content: 'This is an extraction task. Single pass. Could be fast, '
            + 'but it requires careful analysis of unstructured text. thinking',
    });
    const out = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(out.tier, 'thinking');
    assert.strictEqual(out.method, 'llm');
});

test('extractTierWord picks the LAST whole-word tier mention', () => {
    assert.strictEqual(
        extractTierWord('thinking? no — too simple, go with fast', TIERS),
        'fast'
    );
    // deep_thinking must not be shadowed by its "thinking" suffix.
    assert.strictEqual(
        extractTierWord('maybe thinking, but this needs deep_thinking', TIERS),
        'deep_thinking'
    );
    // "thinking" inside "deep_thinking" is not a whole-word match on its own.
    assert.strictEqual(extractTierWord('deep_thinking', TIERS), 'deep_thinking');
    assert.strictEqual(extractTierWord('no tier here at all', TIERS), null);
});

test('legacy alias in a verbose reply is normalised (pro → deep_thinking)', async () => {
    reset({ content: 'This needs heavy reasoning, so: pro' });
    const out = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(out.tier, 'deep_thinking');
    assert.strictEqual(out.method, 'llm');
});

test('garbage reply falls back to heuristic AND caches the fallback', async () => {
    reset({ content: 'zebra unicorn nonsense' });
    const first = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(first.method, 'heuristic');
    assert.strictEqual(first.tier, 'fast');
    assert.strictEqual(chatCalls.length, 1);

    // Same message again: served from cache, no second LLM call.
    const second = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(second.method, 'cache');
    assert.strictEqual(second.tier, 'fast');
    assert.strictEqual(chatCalls.length, 1);
});

test('LLM transport error falls back and caches too', async () => {
    reset({ error: new Error('boom') });
    const first = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(first.method, 'heuristic');
    assert.strictEqual(chatCalls.length, 1);

    const second = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(second.method, 'cache');
    assert.strictEqual(chatCalls.length, 1);
});

test('a short plain question is fast without any call', async () => {
    reset();
    const out = await classifyWithLLM('what is the capital of France?', TIERS);
    assert.strictEqual(out.tier, 'fast');
    assert.strictEqual(out.method, 'shortcut');
    assert.strictEqual(serviceCalls.length, 0);
    assert.strictEqual(chatCalls.length, 0);
});

test('a short message with code or arithmetic is not shortcut', () => {
    assert.strictEqual(classifyPromptComplexity('fix foo(); bar();').reason === 'short plain question', false);
    assert.strictEqual(classifyPromptComplexity('what is 12 * 34?').reason === 'short plain question', false);
});

test('classify-service verdict wins and the LLM is never asked', async () => {
    reset({ service: { tier: 'deep_thinking', score: 0.91, ms: 120 } });
    const out = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(out.tier, 'deep_thinking');
    assert.strictEqual(out.method, 'classifier');
    assert.strictEqual(chatCalls.length, 0);
    assert.ok(serviceCalls[0].opts.heuristic, 'heuristic signals go along for the clamp');

    const again = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(again.method, 'cache');
    assert.strictEqual(serviceCalls.length, 1);
});

test('no service verdict falls through to the LLM', async () => {
    reset({ service: null, content: 'thinking' });
    const out = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.strictEqual(serviceCalls.length, 1);
    assert.strictEqual(out.method, 'llm');
    assert.strictEqual(out.tier, 'thinking');
});

test('LLM call is time-bounded and gets a timeoutMs and a signal', async () => {
    reset({ hang: true });
    const started = Date.now();
    const out = await classifyWithLLM(AMBIGUOUS_MSG, TIERS);
    assert.ok(Date.now() - started < 1000, 'a hanging LLM must not hold the turn');
    assert.strictEqual(out.method, 'heuristic');
    assert.strictEqual(chatCalls[0].options.timeoutMs, 50);
    assert.ok(chatCalls[0].options.signal instanceof AbortSignal);
});

test('a long message reaches the LLM as its start and its end', async () => {
    reset({ content: 'writer' });
    const long = `START ${'lorem ipsum dolor '.repeat(400)} END`;
    await classifyWithLLM(long, { ...TIERS, writer: { modelId: 'model-writer' } });
    const sent = chatCalls[0].messages[1].content;
    assert.ok(sent.length < long.length);
    assert.ok(sent.length <= 2010);
    assert.ok(sent.startsWith('START'));
    assert.ok(sent.endsWith('END'));
});
