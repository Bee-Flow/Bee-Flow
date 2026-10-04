/**
 * llmClient hands consumers the usage a provider really reported.
 *
 * `runToolLoop` used to sum `prompt_tokens`/`completion_tokens`/`cached_tokens`
 * out of whatever `adapter.chat` returned. The non-streaming Claude and Gemini
 * adapters returned the RAW provider block (`input_tokens`, `usageMetadata`),
 * so a loop over either logged 0 tokens at 0 cost and lost the cache. These
 * tests drive the real adapters (only the SDK client is stubbed).
 *
 * Run: node --test core/llm/llmClient.usage.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');
const restoreStores = installResolveStub({
    '../../stores/configStore': {
        getConfig: async () => null, setConfig: async () => {}, getSecret: async () => null, setSecret: async () => {},
    },
});
after(() => restoreStores());

const llmClient = require('./llmClient');
const { realClaudeAdapter, realGeminiAdapter, assertClaudeEntry, assertGeminiEntry } = require('../providers/usageHarness');

const MSGS = [{ role: 'user', content: 'hi' }];
const TOOLS = [{ type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } } }];

function withAdapter(adapter, fn) {
    const orig = llmClient._resolve;
    llmClient._resolve = async () => ({
        apiKey: 'k', baseUrl: '', adapter, providerType: adapter.name, modelId: 'm',
        project: 'p', location: null, serviceAccountKey: null,
    });
    return Promise.resolve(fn()).finally(() => { llmClient._resolve = orig; });
}

test('chat(): a Claude call returns usage with tokens and cache, not the raw block', async () => {
    await withAdapter(realClaudeAdapter([{ text: 'hello' }]), async () => {
        const r = await llmClient.chat('claude-sonnet-4-6', MSGS);
        assertClaudeEntry(r.usage);
    });
});

test('runToolLoop: two Claude rounds sum tokens, cache read/write and the 5m/1h split', async () => {
    const adapter = realClaudeAdapter([{ toolUse: { name: 'lookup' } }, { text: 'done' }]);
    await withAdapter(adapter, async () => {
        const r = await llmClient.runToolLoop('claude-sonnet-4-6', MSGS, TOOLS, {}, async () => 'result');
        assert.strictEqual(r.content, 'done');
        assert.strictEqual(r.toolCallRounds, 1);
        assertClaudeEntry(r.usage, 2);
        assert.ok(r.usage.prompt_tokens + r.usage.completion_tokens > 0, 'never the zero-token row');
    });
});

test('runToolLoop: two Gemini rounds sum tokens, thoughts and cache', async () => {
    const adapter = realGeminiAdapter([{ toolUse: { name: 'lookup' } }, { text: 'done' }]);
    await withAdapter(adapter, async () => {
        const r = await llmClient.runToolLoop('gemini-3-flash-preview', MSGS, TOOLS, {}, async () => 'result');
        assert.strictEqual(r.content, 'done');
        assertGeminiEntry(r.usage, 2);
    });
});

test('runToolLoop: Vertex inherits the same accounting', async () => {
    const adapter = realGeminiAdapter([{ text: 'done' }], { vertex: true });
    await withAdapter(adapter, async () => {
        const r = await llmClient.runToolLoop('gemini-3-flash-preview', MSGS, TOOLS, {}, async () => 'x');
        assertGeminiEntry(r.usage);
    });
});

test('runToolLoop: camelCase usage from an adapter that has not been migrated is still counted', async () => {
    const orig = llmClient._resolve;
    llmClient._resolve = async () => ({
        apiKey: 'k', baseUrl: '', providerType: 'x', modelId: 'm', project: null, location: null, serviceAccountKey: null,
        adapter: { name: 'x', chat: async () => ({ content: 'ok', toolCalls: null, usage: { promptTokens: 9, completionTokens: 4, cachedTokens: 3 } }) },
    });
    try {
        const r = await llmClient.runToolLoop('m', MSGS, TOOLS, {}, async () => 'x');
        assert.deepStrictEqual([r.usage.prompt_tokens, r.usage.completion_tokens, r.usage.cached_tokens], [9, 4, 3]);
    } finally { llmClient._resolve = orig; }
});
