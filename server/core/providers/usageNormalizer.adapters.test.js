/**
 * Regression: the NON-streaming Claude and Gemini/Vertex paths used to hand the
 * raw provider usage block to callers that read only prompt_tokens /
 * completion_tokens, so every such call was logged with 0 tokens, 0 cost and no
 * cache. These tests run the real adapters against a stubbed SDK client and pin
 * that chat() and stream() now emit the SAME normalised shape.
 *
 * Run: node --test core/providers/usageNormalizer.adapters.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const ClaudeProvider = require('./claude');
const GoogleProvider = require('./google');
const GoogleVertexProvider = require('./googleVertex');

const MSGS = [{ role: 'user', content: 'hello' }];

const CLAUDE_USAGE = {
    input_tokens: 120,
    output_tokens: 80,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 700,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 500 },
    service_tier: 'standard',
    inference_geo: 'us',
    server_tool_use: { web_search_requests: 2 },
};

const GEMINI_USAGE = {
    promptTokenCount: 1000,
    candidatesTokenCount: 100,
    thoughtsTokenCount: 400,
    cachedContentTokenCount: 600,
    totalTokenCount: 1500,
    trafficType: 'ON_DEMAND',
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1000 }],
};

function claudeWith(client) {
    const p = new ClaudeProvider();
    p._resolveAuth = async (key) => ({ token: key, oauth: false });
    p.createClient = () => client;
    return p;
}

function claudeResponse() {
    return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: CLAUDE_USAGE };
}

function assertClaudeShape(u) {
    assert.ok(u, 'usage is present');
    assert.strictEqual(u.prompt_tokens, 120, 'input_tokens stays the uncached remainder');
    assert.strictEqual(u.completion_tokens, 80);
    assert.strictEqual(u.cached_tokens, 5000);
    assert.strictEqual(u.cache_creation_tokens, 700);
    assert.strictEqual(u.cache_creation_5m_tokens, 200);
    assert.strictEqual(u.cache_creation_1h_tokens, 500);
    assert.strictEqual(u.prompt_includes_cache, false);
    assert.strictEqual(u.service_tier, 'standard');
    assert.strictEqual(u.inference_geo, 'us');
    assert.deepStrictEqual(u.tool_use, { web_search_requests: 2 });
}

function assertGeminiShape(u) {
    assert.ok(u, 'usage is present');
    assert.strictEqual(u.prompt_tokens, 1000);
    assert.strictEqual(u.completion_tokens, 500, 'thoughts are billed as output');
    assert.strictEqual(u.cached_tokens, 600);
    assert.strictEqual(u.reasoning_tokens, 400);
    assert.strictEqual(u.total_tokens, 1500);
    assert.strictEqual(u.traffic_type, 'on_demand');
    assert.deepStrictEqual(u.modality.prompt, { text: 1000 });
}

test('Claude non-stream chat(): non-zero tokens, cache read/write and the 5m/1h split', async () => {
    const p = claudeWith({ messages: { create: async () => claudeResponse() } });
    const r = await p.chat('key', null, 'claude-sonnet-4-6', MSGS, {});
    assertClaudeShape(r.usage);
    assert.strictEqual(r.usage.prompt_tokens + r.usage.completion_tokens > 0, true);
});

test('Claude stream(): emits the same shape on `done` as chat()', async () => {
    const final = claudeResponse();
    const fakeStream = {
        async *[Symbol.asyncIterator]() { yield { type: 'message_start' }; },
        finalMessage: async () => final,
    };
    const p = claudeWith({ messages: { stream: async () => fakeStream } });
    const events = [];
    await p.stream('key', null, 'claude-sonnet-4-6', MSGS, {}, (type, data) => events.push([type, data]));
    const done = events.find(([t]) => t === 'done')[1];
    assertClaudeShape(done);
    const viaChat = await claudeWith({ messages: { create: async () => claudeResponse() } })
        .chat('key', null, 'claude-sonnet-4-6', MSGS, {});
    for (const k of Object.keys(viaChat.usage)) {
        assert.deepStrictEqual(done[k], viaChat.usage[k], `stream and chat agree on ${k}`);
    }
});

function googleWith(p, ai) {
    p.createClient = () => ai;
    p._supportsExplicitCache = () => false;
    return p;
}

function geminiResponse() {
    return {
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: GEMINI_USAGE,
    };
}

test('Gemini non-stream chat(): non-zero tokens with cache and thoughts', async () => {
    const p = googleWith(new GoogleProvider(), { models: { generateContent: async () => geminiResponse() } });
    const r = await p.chat('key', null, 'gemini-3-flash-preview', MSGS, {});
    assertGeminiShape(r.usage);
});

test('Vertex non-stream chat() inherits the normalised usage', async () => {
    const p = googleWith(new GoogleVertexProvider(), { models: { generateContent: async () => geminiResponse() } });
    const r = await p.chat('key', null, 'gemini-3-flash-preview', MSGS, { project: 'p' });
    assertGeminiShape(r.usage);
});

test('Gemini stream(): `done` carries the same shape as chat()', async () => {
    const chunks = [geminiResponse()];
    const ai = { models: { generateContentStream: async () => (async function* () { yield* chunks; })() } };
    const p = googleWith(new GoogleProvider(), ai);
    const events = [];
    await p.stream('key', null, 'gemini-3-flash-preview', MSGS, {}, (type, data) => events.push([type, data]));
    const done = events.find(([t]) => t === 'done')[1];
    assertGeminiShape(done);
    assert.strictEqual(done.stop_reason, 'STOP');
});

test('no usageMetadata -> null usage, not a raw or empty object', async () => {
    const p = googleWith(new GoogleProvider(), {
        models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) },
    });
    const r = await p.chat('key', null, 'gemini-3-flash-preview', MSGS, {});
    assert.strictEqual(r.usage, null);
});
