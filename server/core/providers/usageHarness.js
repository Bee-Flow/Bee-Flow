/**
 * Test doubles for the usage-accounting tests: the REAL Claude and Gemini
 * adapters with only the SDK client stubbed, so a test drives a genuine
 * non-streaming `adapter.chat()` and sees what a consumer really receives.
 *
 * (Before core/providers/usageNormalizer.js those two returned the raw provider
 * block, which every consumer read as zero tokens.)
 */
const assert = require('node:assert');
const ClaudeProvider = require('./claude');
const GoogleProvider = require('./google');
const GoogleVertexProvider = require('./googleVertex');

/** An Anthropic usage block with a cache read and a MIXED 5m/1h write. */
const CLAUDE_RAW_USAGE = Object.freeze({
    input_tokens: 120,
    output_tokens: 80,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 700,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 500 },
    service_tier: 'standard',
});

/** A Gemini usageMetadata block with thoughts and a cache hit. */
const GEMINI_RAW_USAGE = Object.freeze({
    promptTokenCount: 1000,
    candidatesTokenCount: 100,
    thoughtsTokenCount: 400,
    cachedContentTokenCount: 600,
    totalTokenCount: 1500,
});

/**
 * The real ClaudeProvider whose SDK answers from `script`. An entry is
 * `{ text?, toolUse?: { name, input }, usage? }`; the last entry repeats.
 */
function realClaudeAdapter(script = [{ text: 'ok' }]) {
    const p = new ClaudeProvider();
    let i = 0;
    p._resolveAuth = async (key) => ({ token: key, oauth: false });
    p.createClient = () => ({
        messages: {
            create: async (params) => {
                const step = script[Math.min(i++, script.length - 1)];
                const content = [];
                if (step.text !== undefined) content.push({ type: 'text', text: step.text });
                if (step.toolUse) content.push({
                    type: 'tool_use', id: `tu_${i}`, input: step.toolUse.input || {},
                    // '*' = answer the (forced) tool the request offered first.
                    name: step.toolUse.name === '*' ? (params.tools?.[0]?.name || 'tool') : step.toolUse.name,
                });
                return {
                    content,
                    stop_reason: step.toolUse ? 'tool_use' : 'end_turn',
                    usage: step.usage || CLAUDE_RAW_USAGE,
                };
            },
        },
    });
    return p;
}

/** The real ClaudeProvider whose SDK STREAMS one text block and reports `usage` on finalMessage(). */
function realClaudeStreamAdapter(text = 'hello', usage = CLAUDE_RAW_USAGE) {
    const p = new ClaudeProvider();
    p._resolveAuth = async (key) => ({ token: key, oauth: false });
    p.createClient = () => ({
        messages: {
            stream: async () => ({
                async *[Symbol.asyncIterator]() {
                    yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
                },
                finalMessage: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }),
            }),
        },
    });
    return p;
}

/** The real GoogleProvider (or Vertex) answering from `script`; same entry shape. */
function realGeminiAdapter(script = [{ text: 'ok' }], { vertex = false } = {}) {
    const p = vertex ? new GoogleVertexProvider() : new GoogleProvider();
    let i = 0;
    p._supportsExplicitCache = () => false;
    p.createClient = () => ({
        models: {
            generateContent: async (params) => {
                const step = script[Math.min(i++, script.length - 1)];
                const parts = [];
                if (step.text !== undefined) parts.push({ text: step.text });
                if (step.toolUse) {
                    const offered = params?.config?.tools?.[0]?.functionDeclarations?.[0]?.name;
                    parts.push({ functionCall: { name: step.toolUse.name === '*' ? (offered || 'tool') : step.toolUse.name, args: step.toolUse.input || {} } });
                }
                return {
                    candidates: [{ content: { parts }, finishReason: 'STOP' }],
                    usageMetadata: step.usage || GEMINI_RAW_USAGE,
                };
            },
        },
    });
    return p;
}

/** What a logged usage entry must carry after ONE call with CLAUDE_RAW_USAGE. */
function assertClaudeEntry(entry, times = 1) {
    assert.strictEqual(entry.prompt_tokens, 120 * times, 'input_tokens stays the uncached remainder');
    assert.strictEqual(entry.completion_tokens, 80 * times);
    assert.strictEqual(entry.cached_tokens, 5000 * times, 'cache read is kept');
    assert.strictEqual(entry.cache_creation_tokens, 700 * times, 'cache write is kept');
    assert.strictEqual(entry.cache_creation_5m_tokens, 200 * times);
    assert.strictEqual(entry.cache_creation_1h_tokens, 500 * times, 'the 5m/1h split is carried, not one dominant TTL');
    assert.strictEqual(entry.cache_ttl, '1h');
    assert.strictEqual(entry.service_tier, 'standard');
}

/** What a logged usage entry must carry after ONE call with GEMINI_RAW_USAGE. */
function assertGeminiEntry(entry, times = 1) {
    assert.strictEqual(entry.prompt_tokens, 1000 * times);
    assert.strictEqual(entry.completion_tokens, 500 * times, 'thoughts are billed as output');
    assert.strictEqual(entry.cached_tokens, 600 * times);
    assert.strictEqual(entry.reasoning_tokens, 400 * times);
}

module.exports = {
    CLAUDE_RAW_USAGE, GEMINI_RAW_USAGE,
    realClaudeAdapter, realClaudeStreamAdapter, realGeminiAdapter,
    assertClaudeEntry, assertGeminiEntry,
};
