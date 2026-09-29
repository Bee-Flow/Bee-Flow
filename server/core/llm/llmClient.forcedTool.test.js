/**
 * Forced-tool contract for the LLM client.
 *
 * No provider adapter honours response_format/json_schema, so structured output
 * rides on a FORCED tool call. These tests pin:
 *  - the provider-correct toolChoice SHAPE that chatForcedTool / runToolLoop emit:
 *      · openai / claude / mistral / generic → {type:'function',function:{name}}
 *      · google (and google-vertex, which extends GoogleProvider) → 'required'
 *        (single-tool list + mode ANY === forcing that one tool)
 *      · every self-hosted flavour (LocalProvider) → 'required' — llama-server
 *        reads the object form as "auto" (2026-09-17)
 *  - chatForcedTool returns parsed `structured` args, and null (no throw) when the
 *    model declines the tool or emits unparseable args; the answer is read by
 *    tool name, then from a call written as text, then from the content, and
 *    `stopReason` / `rawArguments` ride along for a repair round.
 *  - runToolLoop with finalTool forces the synthesis call on BOTH exit paths and
 *    is byte-for-byte backward compatible when finalTool is omitted.
 *
 * Strategy: stub `_resolve` on the singleton to inject a fake adapter and capture
 * exactly what options reach `adapter.chat`. The Google nuance is exercised with
 * the REAL exported googleAdapter (a genuine `GoogleProvider instanceof` check),
 * but with its `chat` stubbed so no SDK/network is touched.
 *
 * DB-free: llmClient requires `../aiAgent`, whose provider config
 * (core/llm/providerConfig.js) requires `../../stores/configStore`. Loading
 * that store pulled in real Postgres work at require time — its CREATE TABLE
 * + its dedicated `pg` LISTEN client — so it is cut with installResolveStub;
 * the key is the require string exactly as written in the module that
 * requires it. Nothing under test is stubbed: llmClient, the provider
 * adapters and claude.js all load for real (probe: `../../db` is still
 * required by core/llm/modelCache.js and still loads — it only constructs a
 * lazy pg Pool, opens no socket, and its monitor timer is unref'd).
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// Key = the require string as written inside core/llm/providerConfig.js (NOT
// relative to this file). A mismatch here fails silently: the real store
// loads and the DB connection comes back.
const restoreStores = installResolveStub({
    '../../stores/configStore': {
        getConfig: async () => null,
        setConfig: async () => {},
        getSecret: async () => null,
        setSecret: async () => {},
    },
});
after(() => restoreStores());

const llmClient = require('./llmClient');
const { googleAdapter, openaiAdapter, claudeAdapter, mistralAdapter } = require('../providers/index');

const TOOL_DEF = {
    type: 'function',
    function: {
        name: 'emit_result',
        description: 'Emit the structured result',
        parameters: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
};

/**
 * Replace llmClient._resolve so it yields `adapter` (with a stubbed chat that
 * records its options and returns `chatResult`). Returns { calls, restore }.
 */
function stubResolve(adapter, chatResult) {
    const calls = [];
    const origResolve = llmClient._resolve;
    const origChat = adapter.chat;
    adapter.chat = async (_apiKey, _baseUrl, _modelId, messages, options) => {
        calls.push({ messages, options });
        return typeof chatResult === 'function' ? chatResult(calls.length) : chatResult;
    };
    llmClient._resolve = async () => ({
        apiKey: 'k', baseUrl: '', adapter, providerType: adapter.name, modelId: 'm',
        project: null, location: null, serviceAccountKey: null, apiVersion: null,
    });
    return {
        calls,
        restore() { llmClient._resolve = origResolve; adapter.chat = origChat; },
    };
}

function toolCall(name, args) {
    return { id: 'call_1', function: { name, arguments: args } };
}

// ─── chatForcedTool: toolChoice shape per provider ──────────────────────────

test('chatForcedTool forces object toolChoice for OpenAI', async () => {
    const s = stubResolve(openaiAdapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')], usage: { total: 1 } });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(s.calls[0].options.toolChoice, { type: 'function', function: { name: 'emit_result' } });
        assert.deepStrictEqual(s.calls[0].options.tools, [TOOL_DEF]);
        assert.deepStrictEqual(out.structured, { ok: true });
        assert.deepStrictEqual(out.usage, { total: 1 });
    } finally { s.restore(); }
});

test('chatForcedTool forces object toolChoice for Claude', async () => {
    const s = stubResolve(claudeAdapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":false}')] });
    try {
        const out = await llmClient.chatForcedTool('claude-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(s.calls[0].options.toolChoice, { type: 'function', function: { name: 'emit_result' } });
        assert.deepStrictEqual(out.structured, { ok: false });
    } finally { s.restore(); }
});

test('chatForcedTool forces object toolChoice for Mistral', async () => {
    const s = stubResolve(mistralAdapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] });
    try {
        await llmClient.chatForcedTool('mistral-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(s.calls[0].options.toolChoice, { type: 'function', function: { name: 'emit_result' } });
    } finally { s.restore(); }
});

test("chatForcedTool forces single-tool-list + 'required' for Google", async () => {
    const s = stubResolve(googleAdapter, { content: null, toolCalls: [{ id: 'c', function: { name: 'emit_result' }, input: { ok: true } }] });
    try {
        const out = await llmClient.chatForcedTool('gemini-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        // Google has no object/name case → 'required' (mode ANY) with a single-tool list.
        assert.strictEqual(s.calls[0].options.toolChoice, 'required');
        assert.deepStrictEqual(s.calls[0].options.tools, [TOOL_DEF]);
        // Google args arrive already-parsed via `input`, not a JSON string.
        assert.deepStrictEqual(out.structured, { ok: true });
    } finally { s.restore(); }
});

// ─── chatForcedTool: untrusted output, never throws ─────────────────────────

test('chatForcedTool returns null structured when model emits no tool call (prose)', async () => {
    const s = stubResolve(openaiAdapter, { content: 'I refuse to use the tool', toolCalls: [] });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
        assert.strictEqual(out.content, 'I refuse to use the tool');
    } finally { s.restore(); }
});

test('chatForcedTool returns null structured on unparseable args without throwing', async () => {
    const s = stubResolve(openaiAdapter, { content: null, toolCalls: [toolCall('emit_result', '{not valid json')] });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
    } finally { s.restore(); }
});

test('chatForcedTool returns null structured when toolCalls absent entirely', async () => {
    const s = stubResolve(openaiAdapter, { content: 'hello' });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
    } finally { s.restore(); }
});

// ─── runToolLoop: finalTool forcing on both exit paths ──────────────────────

test('runToolLoop with finalTool forces structured synthesis when model stops calling tools', async () => {
    // Round 1: a normal tool call. Round 2: model stops → forced finalTool synthesis.
    const s = stubResolve(openaiAdapter, (n) => {
        if (n === 1) return { content: null, toolCalls: [toolCall('search', '{"q":"x"}')] };
        if (n === 2) return { content: 'done thinking', toolCalls: [] };      // model stops
        return { content: null, toolCalls: [toolCall('final_emit', '{"summary":"ok"}')] }; // forced synthesis
    });
    try {
        const finalTool = { type: 'function', function: { name: 'final_emit', parameters: {} } };
        const res = await llmClient.runToolLoop(
            'gpt-x',
            [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }],
            { finalTool },
            async () => 'tool-result',
            5,
        );
        // 3 chats: round1 (auto), round2 (auto, no tools), synthesis (forced)
        assert.strictEqual(s.calls.length, 3);
        assert.strictEqual(s.calls[0].options.toolChoice, 'auto');
        assert.strictEqual(s.calls[1].options.toolChoice, 'auto');
        assert.deepStrictEqual(s.calls[2].options.toolChoice, { type: 'function', function: { name: 'final_emit' } });
        assert.deepStrictEqual(s.calls[2].options.tools, [finalTool]);
        assert.deepStrictEqual(res.structured, { summary: 'ok' });
        // finalTool must NOT leak into chat options as a stray field.
        assert.strictEqual(s.calls[0].options.finalTool, undefined);
    } finally { s.restore(); }
});

test('runToolLoop with finalTool forces structured synthesis on max-rounds-hit', async () => {
    // Always returns a tool call → never naturally exits → max rounds, then forced synthesis.
    const s = stubResolve(openaiAdapter, (n) => {
        if (n <= 2) return { content: null, toolCalls: [toolCall('search', '{}')] };
        return { content: null, toolCalls: [toolCall('final_emit', '{"summary":"capped"}')] };
    });
    try {
        const finalTool = { type: 'function', function: { name: 'final_emit', parameters: {} } };
        const res = await llmClient.runToolLoop(
            'gpt-x',
            [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }],
            { finalTool },
            async () => 'tool-result',
            2, // maxRounds
        );
        // 2 loop chats + 1 forced synthesis
        assert.strictEqual(s.calls.length, 3);
        assert.deepStrictEqual(s.calls[2].options.toolChoice, { type: 'function', function: { name: 'final_emit' } });
        assert.deepStrictEqual(res.structured, { summary: 'capped' });
        assert.strictEqual(res.toolCallRounds, 2);
    } finally { s.restore(); }
});

// ─── runToolLoop: backward compatibility when finalTool omitted ─────────────

test('runToolLoop without finalTool is unchanged (auto loop, final chat drops tools, structured null)', async () => {
    const s = stubResolve(openaiAdapter, (n) => {
        if (n <= 2) return { content: null, toolCalls: [toolCall('search', '{}')] };
        return { content: 'final prose', toolCalls: [] };
    });
    try {
        const res = await llmClient.runToolLoop(
            'gpt-x',
            [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }],
            {},
            async () => 'tool-result',
            2,
        );
        // Final (post-max-rounds) chat drops tools entirely.
        assert.strictEqual(s.calls[2].options.tools, undefined);
        assert.strictEqual(res.content, 'final prose');
        assert.strictEqual(res.structured, null);
    } finally { s.restore(); }
});

// ─── claude.js actually TRANSLATES the forced toolChoice shape ──────────────
// The tests above stub adapter.chat, so they only pin the SHAPE chatForcedTool
// emits — they never exercise the provider's own toolChoice → tool_choice
// mapping. claude.js previously only honoured a top-level `.name`, so the
// OpenAI wire shape {type:'function',function:{name}} that forcedToolChoice emits
// fell through and ran with tool_choice UNSET (auto) — the model declined the
// tool and every forced scan returned 0 suggestions. Pin the real mapping.

test('claude _buildSdkParams maps the OpenAI forced-tool shape to {type:tool,name}', () => {
    const params = claudeAdapter._buildSdkParams('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF],
        toolChoice: { type: 'function', function: { name: 'emit_result' } },
    });
    assert.deepStrictEqual(params.tool_choice, { type: 'tool', name: 'emit_result' });
});

test('claude _buildSdkParams still honours the bare {name} forced-tool shape', () => {
    const params = claudeAdapter._buildSdkParams('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF],
        toolChoice: { name: 'emit_result' },
    });
    assert.deepStrictEqual(params.tool_choice, { type: 'tool', name: 'emit_result' });
});

test("claude _buildSdkParams maps 'required'/'auto' to Anthropic shapes", () => {
    const req = claudeAdapter._buildSdkParams('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF], toolChoice: 'required',
    });
    assert.deepStrictEqual(req.tool_choice, { type: 'any' });
    const auto = claudeAdapter._buildSdkParams('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF], toolChoice: 'auto',
    });
    assert.deepStrictEqual(auto.tool_choice, { type: 'auto' });
});

// ─── forced tool_choice suppresses extended thinking ────────────────────────
// Anthropic rejects `any`/`tool` tool_choice while extended thinking is enabled
// (only auto/none are compatible — implement-tool-use docs). claude-sonnet-4-6
// thinks by default, so a forced call used to 400 every time. The force must
// win: thinking is dropped for that call, the tool_choice is still mapped.

test('claude forced tool on a thinking model drops thinking, keeps {type:tool,name}', () => {
    const params = claudeAdapter._buildSdkParams('claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF],
        toolChoice: { type: 'function', function: { name: 'emit_result' } },
    });
    assert.deepStrictEqual(params.tool_choice, { type: 'tool', name: 'emit_result' });
    assert.strictEqual(params.thinking, undefined);
    assert.strictEqual(params.output_config, undefined);
});

test("claude 'required' on a thinking model drops thinking, keeps {type:any}", () => {
    const params = claudeAdapter._buildSdkParams('claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF], toolChoice: 'required',
    });
    assert.deepStrictEqual(params.tool_choice, { type: 'any' });
    assert.strictEqual(params.thinking, undefined);
});

test("claude 'auto' on a thinking model keeps thinking enabled", () => {
    const params = claudeAdapter._buildSdkParams('claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF], toolChoice: 'auto',
    });
    assert.deepStrictEqual(params.tool_choice, { type: 'auto' });
    assert.ok(params.thinking, 'thinking must stay on for non-forced calls');
});

test('runToolLoop without finalTool: natural exit returns content and structured null', async () => {
    const s = stubResolve(openaiAdapter, { content: 'just an answer', toolCalls: [] });
    try {
        const res = await llmClient.runToolLoop(
            'gpt-x',
            [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }],
            {},
            async () => 'tool-result',
            5,
        );
        assert.strictEqual(s.calls.length, 1);
        assert.strictEqual(s.calls[0].options.toolChoice, 'auto');
        assert.strictEqual(res.content, 'just an answer');
        assert.strictEqual(res.structured, null);
    } finally { s.restore(); }
});

// ─── chatForcedTool: native structured output ───────────────────────────────

// A schema that satisfies structured outputs: every object closed, every
// property required. Only these can be enforced by the provider.
const STRICT_TOOL_DEF = {
    type: 'function',
    function: {
        name: 'emit_result',
        description: 'Emit the structured result',
        parameters: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
        },
    },
};

test('a strict-safe schema takes the native route on OpenAI — one call, no tools', async () => {
    const s = stubResolve(openaiAdapter, { content: '{"ok":true}', toolCalls: null, usage: { total: 2 } });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], STRICT_TOOL_DEF);
        assert.strictEqual(s.calls.length, 1, 'no probe-then-retry');
        assert.strictEqual(s.calls[0].options.tools, undefined, 'no forced tool needed');
        assert.deepStrictEqual(s.calls[0].options.responseFormat, {
            type: 'json_schema',
            json_schema: { name: 'emit_result', schema: STRICT_TOOL_DEF.function.parameters },
        });
        assert.deepStrictEqual(out.structured, { ok: true });
        assert.deepStrictEqual(out.usage, { total: 2 });
    } finally { s.restore(); }
});

test('a loose schema skips the native route entirely — no wasted call', async () => {
    // TOOL_DEF has no `required` and no `additionalProperties:false`, so the
    // provider cannot constrain decoding to it.
    const s = stubResolve(openaiAdapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] });
    try {
        await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(s.calls.length, 1);
        assert.deepStrictEqual(s.calls[0].options.tools, [TOOL_DEF], 'went straight to the forced tool');
        assert.strictEqual(s.calls[0].options.responseFormat, undefined);
    } finally { s.restore(); }
});

test('native output wrapped in a code fence is still parsed', async () => {
    const s = stubResolve(openaiAdapter, { content: '```json\n{"ok":false}\n```', toolCalls: null });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], STRICT_TOOL_DEF);
        assert.deepStrictEqual(out.structured, { ok: false });
    } finally { s.restore(); }
});

test('an unparseable native answer falls back to the forced tool', async () => {
    const s = stubResolve(openaiAdapter, (n) => (n === 1
        ? { content: 'I think it is fine, actually.', toolCalls: null }
        : { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] }));
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], STRICT_TOOL_DEF);
        assert.strictEqual(s.calls.length, 2, 'retried on the route that always works');
        assert.deepStrictEqual(s.calls[1].options.toolChoice, { type: 'function', function: { name: 'emit_result' } });
        assert.deepStrictEqual(out.structured, { ok: true });
    } finally { s.restore(); }
});

test('providers without native support are untouched by any of this', async () => {
    for (const adapter of [claudeAdapter, mistralAdapter, googleAdapter]) {
        const s = stubResolve(adapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] });
        try {
            await llmClient.chatForcedTool('m', [{ role: 'user', content: 'hi' }], STRICT_TOOL_DEF);
            assert.strictEqual(s.calls.length, 1, `${adapter.name}: single call`);
            assert.strictEqual(s.calls[0].options.responseFormat, undefined, `${adapter.name}: no responseFormat`);
            assert.deepStrictEqual(s.calls[0].options.tools, [STRICT_TOOL_DEF], `${adapter.name}: forced tool`);
        } finally { s.restore(); }
    }
});

// ─── self-hosted runtimes: 'required', never the object form ────────────────
// llama-server reads tool_choice as a STRING and answers the object form with
// "Wrong type supplied" + the default (auto): 253 router-journal warnings in
// three days, every forced call on the demo box unforced. With a single-tool
// list, 'required' is "call that tool" on every self-hosted runtime.

const { localAdapters, LocalProvider } = require('../providers/index');

test("chatForcedTool sends single-tool-list + 'required' to EVERY local flavour", async () => {
    for (const [flavor, adapter] of Object.entries(localAdapters)) {
        assert.ok(adapter instanceof LocalProvider, flavor);
        const s = stubResolve(adapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')], stop_reason: 'tool_calls' });
        try {
            const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
            assert.strictEqual(s.calls[0].options.toolChoice, 'required', `${flavor}: string form`);
            assert.deepStrictEqual(s.calls[0].options.tools, [TOOL_DEF], `${flavor}: exactly one tool`);
            assert.strictEqual(s.calls[0].options.responseFormat, undefined, `${flavor}: no native route`);
            assert.deepStrictEqual(out.structured, { ok: true });
            assert.strictEqual(out.stopReason, 'tool_calls');
            assert.strictEqual(out.rawArguments, '{"ok":true}');
        } finally { s.restore(); }
    }
});

test("runToolLoop finalTool synthesis uses 'required' on a local adapter", async () => {
    const s = stubResolve(localAdapters.llamacpp, (n) => (n === 1
        ? { content: 'no tools needed', toolCalls: [] }
        : { content: null, toolCalls: [toolCall('final_emit', '{"summary":"local"}')] }));
    try {
        const finalTool = { type: 'function', function: { name: 'final_emit', parameters: {} } };
        const res = await llmClient.runToolLoop('local-x', [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }], { finalTool }, async () => 'r', 5);
        assert.strictEqual(s.calls[1].options.toolChoice, 'required');
        assert.deepStrictEqual(s.calls[1].options.tools, [finalTool]);
        assert.deepStrictEqual(res.structured, { summary: 'local' });
    } finally { s.restore(); }
});

test('the cloud adapters keep the object form — nothing changed for them', async () => {
    for (const adapter of [openaiAdapter, claudeAdapter, mistralAdapter]) {
        const s = stubResolve(adapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] });
        try {
            await llmClient.chatForcedTool('m', [{ role: 'user', content: 'hi' }], TOOL_DEF);
            assert.deepStrictEqual(s.calls[0].options.toolChoice, { type: 'function', function: { name: 'emit_result' } }, adapter.name);
        } finally { s.restore(); }
    }
});

test('forcedToolChoiceFor resolves the adapter and answers the same as forcedToolChoice', async () => {
    const s = stubResolve(localAdapters.vllm, { content: null, toolCalls: [] });
    try {
        assert.strictEqual(await llmClient.forcedToolChoiceFor('local-x', 'return_structured_output'), 'required');
        assert.strictEqual(s.calls.length, 0, 'no chat was made');
    } finally { s.restore(); }
    assert.deepStrictEqual(llmClient.forcedToolChoice(openaiAdapter, 'x'), { type: 'function', function: { name: 'x' } });
    assert.strictEqual(llmClient.forcedToolChoice(localAdapters.ollama, 'x'), 'required');
});

// ─── extraction: where the model put the answer ─────────────────────────────

test('chatForcedTool prefers the call whose name matches over the first call', async () => {
    const s = stubResolve(localAdapters.llamacpp, {
        content: null,
        toolCalls: [toolCall('app_set_meta', '{"name":"first"}'), { id: 'call_2', function: { name: 'emit_result', arguments: '{"ok":true}' } }],
    });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(out.structured, { ok: true });
        assert.strictEqual(out.rawArguments, '{"ok":true}');
    } finally { s.restore(); }
});

test('chatForcedTool reads a call the model wrote into its reasoning (Gemma wire syntax, unsigned thinking)', async (t) => {
    const warned = [];
    t.mock.method(console, 'warn', (line) => warned.push(String(line)));
    const s = stubResolve(localAdapters['openai-compatible'], {
        content: null,
        toolCalls: null,
        thinking: 'I should answer with the tool.\n<|tool_call>call:emit_result{ok:true,note:<|">done<|">}<tool_call|>',
        stop_reason: 'stop',
    });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(out.structured, { ok: true, note: 'done' });
        assert.strictEqual(out.stopReason, 'stop');
        assert.strictEqual(out.rawArguments, '{"ok":true,"note":"done"}', 'the recovered call is the raw the repair round quotes');
        assert.ok(warned.some(l => /answer read from written as text in the thinking/.test(l)), warned.join('\n'));
    } finally { s.restore(); }
});

test('chatForcedTool reads a call written into the content, and a bare JSON body still goes through the content parser', async () => {
    const written = stubResolve(localAdapters.llamacpp, {
        content: 'Sure.\n<tool_call>{"name":"emit_result","arguments":{"ok":false}}</tool_call>',
        toolCalls: [],
    });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(out.structured, { ok: false });
    } finally { written.restore(); }
    // An answer body that happens to have a `name` key is the answer, not a call wrapper.
    const body = stubResolve(localAdapters.llamacpp, { content: '{"name":"invoices","ok":true}', toolCalls: [] });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(out.structured, { name: 'invoices', ok: true });
    } finally { body.restore(); }
});

test('chatForcedTool surfaces stopReason and rawArguments when nothing parses, and logs the raw (capped at 4 kB)', async (t) => {
    const warned = [];
    t.mock.method(console, 'warn', (line) => warned.push(String(line)));
    const raw = '{"ok":true,"text":"' + 'x'.repeat(6000);   // cut inside a string at max_tokens
    const s = stubResolve(localAdapters.llamacpp, { content: null, toolCalls: [toolCall('emit_result', raw)], stop_reason: 'length' });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
        assert.strictEqual(out.stopReason, 'length');
        assert.strictEqual(out.rawArguments, raw);
        const line = warned.find(l => /arguments unparsable/.test(l));
        assert.ok(line, warned.join('\n'));
        assert.match(line, /emit_result on local-x/);
        assert.match(line, /stop=length, 6019 chars/);
        assert.ok(line.length < 4096 + 200, `capped: ${line.length}`);
    } finally { s.restore(); }
});

test('chatForcedTool resolves (structured null, stopReason length) on a runaway nesting — the loose parser used to throw a RangeError through it', async (t) => {
    t.mock.method(console, 'warn', () => {});
    // A model looping on `[` until max_tokens: not JSON, and deeper than any
    // argument object. The composer keys compose_truncated on stopReason;
    // a rejected promise here was a 500 instead.
    const raw = '{"steps":' + '['.repeat(6000);
    const s = stubResolve(localAdapters.llamacpp, { content: null, toolCalls: [toolCall('emit_result', raw)], stop_reason: 'length' });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
        assert.strictEqual(out.stopReason, 'length');
        assert.strictEqual(out.rawArguments, raw);
    } finally { s.restore(); }
    assert.strictEqual(llmClient.parseToolCallArgs(toolCall('emit_result', raw)), null, 'the bare parser never throws either');
});

test('chatForcedTool repairs arguments written in the Gemma DSL, or cut right after a complete entry', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const dsl = stubResolve(localAdapters.llamacpp, { content: null, toolCalls: [toolCall('emit_result', '{ok:true,items:[{a:1},{b:<|">two<|">}]}<tool_call|>')] });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(out.structured, { ok: true, items: [{ a: 1 }, { b: 'two' }] });
        assert.strictEqual(out.rawArguments, '{ok:true,items:[{a:1},{b:<|">two<|">}]}<tool_call|>', 'raw is what arrived, not the repair');
    } finally { dsl.restore(); }
    const cut = stubResolve(localAdapters.llamacpp, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true,"items":[{"a":1},{"b":2}')], stop_reason: 'length' });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(out.structured, { ok: true, items: [{ a: 1 }, { b: 2 }] });
        assert.strictEqual(out.stopReason, 'length');
    } finally { cut.restore(); }
});

test('chatForcedTool logs a garbled hit but still hands the object to the caller', async (t) => {
    const warned = [];
    t.mock.method(console, 'warn', (line) => warned.push(String(line)));
    // playbook-refusals #37: a string value that swallowed the rest of the batch.
    const args = JSON.stringify({ ok: true, type: 'text}]}}]}<tool_call|><|tool_call>call:app_set_action{action:{kind:' });
    const s = stubResolve(localAdapters.llamacpp, { content: null, toolCalls: [toolCall('emit_result', args)] });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured.ok, true);
        assert.ok(warned.some(l => /args look garbled/.test(l)), warned.join('\n'));
    } finally { s.restore(); }
    // A clean answer logs nothing.
    warned.length = 0;
    const clean = stubResolve(localAdapters.llamacpp, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] });
    try {
        await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(warned, []);
    } finally { clean.restore(); }
});

test('the native route also carries the additive fields, with rawArguments null', async () => {
    const s = stubResolve(openaiAdapter, { content: '{"ok":true}', toolCalls: null, stop_reason: 'stop' });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], STRICT_TOOL_DEF);
        assert.strictEqual(out.stopReason, 'stop');
        assert.strictEqual(out.rawArguments, null);
    } finally { s.restore(); }
    // Claude hands up an object: no raw string exists.
    const c = stubResolve(claudeAdapter, { content: null, toolCalls: [{ id: 'c', function: { name: 'emit_result' }, input: { ok: true } }] });
    try {
        const out = await llmClient.chatForcedTool('claude-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(out.structured, { ok: true });
        assert.strictEqual(out.rawArguments, null);
        assert.strictEqual(out.stopReason, null);
    } finally { c.restore(); }
});

test('a camelCase stopReason from the OpenAI / Claude adapters surfaces on both routes', async () => {
    // openai.js and claude.js hand up `stopReason` (base.js says `stop_reason`).
    // Reading only the snake_case name left every cloud cut-off reported as
    // null — a composer then validated a document cut after phase 2 instead
    // of refusing it as truncated.
    const cut = stubResolve(openaiAdapter, {
        content: null,
        toolCalls: [toolCall('emit_result', '{"ok":true,"items":[{"a":1},{"b":2}')],
        stopReason: 'length',
    });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.stopReason, 'length', 'forced-tool route, camelCase');
        assert.deepStrictEqual(out.structured, { ok: true, items: [{ a: 1 }, { b: 2 }] }, 'the loose parse still closes the tail');
    } finally { cut.restore(); }

    const native = stubResolve(openaiAdapter, { content: '{"ok":true}', toolCalls: null, stopReason: 'length' });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], STRICT_TOOL_DEF);
        assert.strictEqual(native.calls[0].options.responseFormat?.type, 'json_schema', 'took the native route');
        assert.strictEqual(out.stopReason, 'length', 'native route, camelCase');
    } finally { native.restore(); }

    // Claude: thinking ate the budget, no tool_use block — the caller must see
    // max_tokens, not "the model answered nothing".
    const claude = stubResolve(claudeAdapter, { content: 'The model hit its output length limit', toolCalls: null, stopReason: 'max_tokens' });
    try {
        const out = await llmClient.chatForcedTool('claude-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
        assert.strictEqual(out.stopReason, 'max_tokens');
    } finally { claude.restore(); }

    // The snake_case name still wins when both are present (base.js is the
    // codebase-wide contract; a camelCase alias is never preferred over it).
    const both = stubResolve(openaiAdapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')], stop_reason: 'tool_calls', stopReason: 'stop' });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.stopReason, 'tool_calls');
    } finally { both.restore(); }
});

// ─── The grammar route on self-hosted runtimes (2026-09-18) ────────────────

test('a local adapter is handed the forced tool itself (forcedTool) beside the single-tool list, and a JSON answer in content is read', async () => {
    const s = stubResolve(localAdapters.llamacpp, { content: '{"ok":true}', toolCalls: [], stop_reason: 'stop' });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(s.calls.length, 1, 'one call: the grammar route answered');
        assert.deepStrictEqual(s.calls[0].options.forcedTool, TOOL_DEF);
        assert.deepStrictEqual(s.calls[0].options.tools, [TOOL_DEF]);
        assert.strictEqual(s.calls[0].options.toolChoice, 'required', 'the tool route stays the request for runtimes that ignore forcedTool');
        assert.deepStrictEqual(out.structured, { ok: true });
        assert.strictEqual(out.rawArguments, null, 'content JSON has no argument string');
    } finally { s.restore(); }
});

test('when the grammar route answers nothing parseable, the plain tool route is tried once — and a cloud adapter never sees forcedTool', async () => {
    const s = stubResolve(localAdapters.vllm, (n) => (n === 1
        ? { content: 'I would rather not.', toolCalls: [], stop_reason: 'stop' }
        : { content: null, toolCalls: [toolCall('emit_result', '{"ok":false}')], stop_reason: 'tool_calls' }));
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(s.calls.length, 2);
        assert.deepStrictEqual(s.calls[0].options.forcedTool, TOOL_DEF);
        assert.strictEqual(s.calls[1].options.forcedTool, undefined, 'the fallback is the plain tool route');
        assert.deepStrictEqual(out.structured, { ok: false });
    } finally { s.restore(); }
    const { OpenAIProvider } = require('../providers/index');
    const cloud = stubResolve(new OpenAIProvider(), { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] });
    try {
        await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], { ...TOOL_DEF, function: { ...TOOL_DEF.function, parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true } } });
        assert.strictEqual(cloud.calls[cloud.calls.length - 1].options.forcedTool, undefined);
    } finally { cloud.restore(); }
});

test('a grammar route the runtime refuses (400) falls back to the tool route; any other error is the caller\'s', async () => {
    const s = stubResolve(localAdapters.llamacpp, (n) => {
        if (n === 1) throw new Error('llamacpp API error 400: {"error":{"message":"Unsupported schema"}}');
        return { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] };
    });
    try {
        const out = await llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(s.calls.length, 2);
        assert.deepStrictEqual(out.structured, { ok: true });
    } finally { s.restore(); }
    const dead = stubResolve(localAdapters.llamacpp, () => { throw new Error('llamacpp API error 500: boom'); });
    try {
        await assert.rejects(() => llmClient.chatForcedTool('local-x', [{ role: 'user', content: 'hi' }], TOOL_DEF), /API error 500/);
        assert.strictEqual(dead.calls.length, 1);
    } finally { dead.restore(); }
});
