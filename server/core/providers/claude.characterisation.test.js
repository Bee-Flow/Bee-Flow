'use strict';

/**
 * Characterisation (golden) test for core/providers/claude.js.
 *
 * Pins EXACTLY what the Claude adapter does today on its main paths: the SDK
 * params _buildSdkParams builds (message normalisation, thinking replay, the
 * prompt-cache breakpoints, tool-pair repair, thinking/effort config, forced
 * tool choice and its `auto` fallback, context management, structured
 * output), the request options and retry sequences of chat(), the result it
 * maps a response to (text, tool calls, refusal, context-window and
 * max_tokens stops) and the ordered onEvent stream of stream(). Written
 * before the file was split into claude/messageRepair.js, claude/errors.js
 * and claude/params.js, so the split can prove it moved code and changed
 * nothing.
 *
 * No network: createClient is replaced with a fake SDK client, and the
 * messages carry no internal images, so the inline / downscale passes are
 * no-ops.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/providers/claude.characterisation.test.js
 *
 * Run: cd server && node --test core/providers/claude.characterisation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
delete process.env.CLAUDE_CONTEXT_EDITING_DISABLED;
delete process.env.CLAUDE_THINKING_DISPLAY;
delete process.env.CLAUDE_KEEP_THINKING_TURNS;
delete process.env.BEEFLOW_CLAUDE_CODE_OAUTH;

const ClaudeProvider = require('./claude');

const GOLDEN = path.join(__dirname, 'claude.characterisation.golden.json');

const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const TOOLS = [
    { type: 'function', function: { name: 'agent_search', description: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
    { name: 'bare_tool', input_schema: { type: 'object', properties: {} } },
];

// A long history that exercises every normalisation branch: system blocks,
// image_url variants, a compaction summary, thinking replay (signed,
// unsigned, redacted), parallel tool results that must merge, an orphan
// tool_result and an orphan tool_use, and a pre-marked attachment block.
const HISTORY = [
    { role: 'system', content: 'You are the stable identity block.' },
    { role: 'system', content: { volatile: 'timestamp' } },
    { role: 'user', content: '[Conversation Summary] earlier turns folded here' },
    { role: 'assistant', content: 'Noted.', thinking: [{ text: 'signed thought', signature: 'sig-1' }, { text: 'unsigned' }, { redacted: true, redactedData: 'opaque' }, { redacted: true }] },
    { role: 'user', content: [
        { type: 'text', text: 'look at these' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: 'https://example.test/a.png', cache_control: { type: 'ephemeral' } },
        { type: 'image_url', image_url: { url: 'ftp://nope' } },
    ] },
    { role: 'assistant', content: 'calling tools', thinking: [{ text: '', signature: 'sig-2' }], tool_calls: [
        { id: 'tu_1', type: 'function', function: { name: 'agent_search', arguments: '{"q":"a"}' } },
        { id: 'tu_2', type: 'function', function: { name: 'agent_search', arguments: 'not json' } },
        { id: 'tu_3', name: 'bare_tool', input: { x: 1 } },
    ] },
    { role: 'tool', tool_call_id: 'tu_1', content: 'result one' },
    { role: 'tool', toolCallId: 'tu_2', content: [{ type: 'text', text: 'result two' }] },
    { role: 'tool', tool_call_id: 'tu_orphan', content: { json: true } },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tu_lost', function: { name: 'agent_search', arguments: '{}' } }] },
    { role: 'user', content: 'previous question' },
    { role: 'assistant', content: [{ type: 'text', text: 'array answer' }], thinking: [{ text: 't', signature: 'sig-3' }] },
    { role: 'assistant', content: '   ', thinking: [{ text: 'only thinking', signature: 'sig-4' }] },
    { role: 'user', content: 'current question' },
    null,
    { content: 'no role' },
];

const SHORT = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }];

const PARAM_CASES = {
    legacyToolsHistory: ['claude-sonnet-4-6', HISTORY, { tools: TOOLS, toolChoice: 'auto', temperature: 0.3 }],
    legacyNoThinking: ['claude-sonnet-4-6', HISTORY, { reasoningEffort: 'none', temperature: 0.2, maxTokens: 1000 }],
    legacyBudget: ['claude-opus-4-6', SHORT, { budgetTokens: 20000, maxTokens: 4000 }],
    adaptiveHigh: ['claude-opus-5', HISTORY, { reasoningEffort: 'high', temperature: 0.7, tools: TOOLS }],
    adaptiveXhigh: ['claude-opus-4-8', SHORT, { reasoningEffort: 'xhigh', maxTokens: 32000 }],
    forcedNamedLegacy: ['claude-sonnet-4-6', SHORT, { tools: TOOLS, toolChoice: { type: 'function', function: { name: 'agent_search' } } }],
    forcedBareNameLegacy: ['claude-sonnet-4-6', SHORT, { tools: TOOLS, toolChoice: { name: 'bare_tool' } }],
    forcedAnyLegacy: ['claude-sonnet-4-6', SHORT, { tools: TOOLS, toolChoice: 'required' }],
    forcedUnsupported: ['claude-sonnet-5-5', SHORT, { tools: TOOLS, toolChoice: { name: 'agent_search' } }],
    forcedAnyUnsupported: ['claude-sonnet-5-5', SHORT, { tools: TOOLS, toolChoice: 'any' }],
    forcedNoForcedFlag: ['claude-sonnet-4-6', SHORT, { tools: TOOLS, toolChoice: 'any', _noForcedToolChoice: true }],
    noThinkingReplay: ['claude-sonnet-4-6', HISTORY, { _noThinkingReplay: true }],
    noContextEditing: ['claude-sonnet-4-6', SHORT, { tools: TOOLS, _noContextEditing: true }],
    oldModel: ['claude-3-5-sonnet-20241022', HISTORY, { tools: TOOLS, temperature: 0.5 }],
    haiku: ['claude-haiku-4-5', SHORT, { temperature: 0.1 }],
    jsonSchema: ['claude-opus-5', SHORT, { reasoningEffort: 'low', responseFormat: { type: 'json_schema', json_schema: { schema: {
        type: 'object', properties: { n: { type: 'number', minimum: 0, maximum: 10 }, s: { type: 'string', maxLength: 'x', minLength: 2 }, a: { type: 'array', items: [{ type: 'integer', multipleOf: 2 }] } },
    } } } }],
};

function paramsScenario() {
    const p = new ClaudeProvider();
    const out = {};
    for (const [key, [model, msgs, opts]] of Object.entries(PARAM_CASES)) {
        const params = p._buildSdkParams(model, clone(msgs), opts);
        out[key] = { params: clone(params), requestOptions: { apiKey: clone(p._requestOptionsFor(params, false)), oauth: clone(p._requestOptionsFor(params, true)) } };
    }
    return out;
}

function helpersScenario() {
    const p = new ClaudeProvider();
    const inject = (system) => { const params = system === undefined ? {} : { system: clone(system) }; p._injectClaudeCodeIdentity(params); p._injectClaudeCodeIdentity(params); return params; };
    return {
        protoKeys: Object.getOwnPropertyNames(ClaudeProvider.prototype).sort(),
        exportType: typeof ClaudeProvider,
        name: p.name ?? null,
        inject: { none: inject(undefined), emptyString: inject(''), string: inject('sys'), array: inject([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }]) },
        extractSystem: { none: clone(p.extractSystem([{ role: 'user', content: 'x' }])), some: clone(p.extractSystem(HISTORY)) },
        normalizeContent: [null, 'str', { obj: 1 }, [{ type: 'image_url', image_url: { url: 'data:bad' } }]].map(c => clone(p.normalizeContent(clone(c)))),
        normalizeTools: p.normalizeTools(TOOLS),
        normalizeShort: clone(p.normalizeMessages(clone(SHORT))),
        normalizeNoThinking: clone(p.normalizeMessages(clone(HISTORY), { keepThinking: false })),
        caps: Object.fromEntries(['claude-sonnet-4-6', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022'].map(m => [m, {
            structured: p.supportsStructuredOutput(m), structuredSchema: p.supportsStructuredOutput(m, { type: 'object', properties: {}, additionalProperties: false }),
            forced: p.supportsForcedToolChoice(m), adaptiveOnly: p.isAdaptiveOnlyReasoning(m), reasoning: p.supportsReasoning(m),
            vision: p.supportsVision(m), documents: p.supportsDocuments(m), contextEditing: p.supportsContextEditing(m),
            thinking: clone(p.buildThinking(m, {})), thinkingNone: clone(p.buildThinking(m, { reasoningEffort: 'none' })), thinkingBudget: clone(p.buildThinking(m, { budgetTokens: 5000 })),
        }])),
        cmRejection: [{ message: 'context_management: nope' }, { error: { msg: 'context-management' } }, { message: 'other' }].map(e => p._isContextManagementRejection(e)),
    };
}

const apiErr = (message, status = 400) => Object.assign(new Error(message), { status, error: { type: 'error', error: { message } } });

const RESPONSES = {
    textAndTools: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }, { type: 'tool_use', id: 't1', name: 'agent_search', input: { q: 'z' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } },
    refusal: { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'Because.' }, usage: { input_tokens: 1, output_tokens: 0 } },
    refusalUnknown: { content: [], stop_reason: 'refusal', stop_details: { category: 'other' } },
    contextWindow: { content: [], stop_reason: 'model_context_window_exceeded' },
    maxTokens: { content: [{ type: 'thinking', thinking: 'long' }], stop_reason: 'max_tokens' },
    maxTokensWithTool: { content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }], stop_reason: 'max_tokens' },
    empty: { stop_reason: 'end_turn' },
};

const OK = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };

const CHAT_SEQUENCES = {
    thinkingReplayRetry: ['claude-sonnet-4-6', HISTORY, { tools: TOOLS }, [apiErr('messages.3.content.0: Invalid `signature` in `thinking` block'), OK]],
    forcedRetry: ['claude-sonnet-4-6', SHORT, { tools: TOOLS, toolChoice: { name: 'agent_search' } }, [apiErr('tool_choice: type "tool" and "any" are not supported for this model.'), OK]],
    contextMgmtRetry: ['claude-sonnet-4-6', SHORT, { tools: TOOLS }, [apiErr('context_management: Extra inputs are not permitted'), OK]],
    otherErrorThrows: ['claude-sonnet-4-6', SHORT, { tools: TOOLS }, [apiErr('overloaded', 529)]],
    thinkingWrongStatus: ['claude-sonnet-4-6', HISTORY, {}, [apiErr('thinking signature invalid', 500)]],
    oauth: ['claude-opus-4-8', SHORT, { tools: TOOLS }, [OK], 'sk-ant-oat-subscription'],
};

function fakeClient(log, script) {
    let i = 0;
    const next = () => {
        const item = script[Math.min(i++, script.length - 1)];
        if (item instanceof Error) throw item;
        return item;
    };
    return {
        messages: {
            create: async (params, requestOptions) => { log.push({ call: 'create', params: clone(params), requestOptions: clone(requestOptions) }); return next(); },
            stream: async (params, requestOptions) => { log.push({ call: 'stream', params: clone(params), requestOptions: clone(requestOptions) }); return next(); },
        },
        models: { list: async () => next() },
    };
}

async function chatScenario() {
    const out = { responses: {}, sequences: {} };
    for (const [key, response] of Object.entries(RESPONSES)) {
        const p = new ClaudeProvider();
        const calls = [];
        p.createClient = () => fakeClient(calls, [response]);
        const r = await p.chat('sk-ant-api', null, 'claude-sonnet-4-6', clone(SHORT), {});
        out.responses[key] = { ...clone({ ...r, raw: undefined }), rawIsResponse: r.raw === response };
    }
    for (const [key, [model, msgs, opts, script, apiKey]] of Object.entries(CHAT_SEQUENCES)) {
        const p = new ClaudeProvider();
        const calls = [];
        const clients = [];
        p.createClient = (token, oauth) => { clients.push({ token, oauth }); return fakeClient(calls, script.slice(calls.length)); };
        let result; let error = null;
        try { result = clone({ ...(await p.chat(apiKey || 'sk-ant-api', 'ignored', model, clone(msgs), opts)), raw: undefined }); }
        catch (e) { error = { message: e.message, status: e.status }; }
        out.sequences[key] = { clients, calls, result: result ?? null, error };
    }
    return out;
}

function fakeStream(events, finalMessage) {
    return {
        async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
        finalMessage: async () => { if (finalMessage instanceof Error) throw finalMessage; return finalMessage; },
    };
}

const STREAM_EVENTS = [
    { type: 'message_start' },
    { type: 'content_block_start', content_block: { type: 'thinking' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pondering' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } },
    { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig-s' } },
    { type: 'content_block_stop' },
    { type: 'content_block_start', content_block: { type: 'redacted_thinking', data: 'opaque-r' } },
    { type: 'content_block_stop' },
    { type: 'content_block_start', content_block: { type: 'redacted_thinking' } },
    { type: 'content_block_stop' },
    { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'stray' } },
    { type: 'content_block_start', content_block: { type: 'text' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } },
    { type: 'content_block_stop' },
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_a', name: 'agent_search' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"x"}' } },
    { type: 'content_block_stop' },
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_b', name: 'agent_search' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{broken' } },
    { type: 'content_block_stop' },
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_c', name: '  ' } },
    { type: 'content_block_stop' },
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_d', name: 'bare_tool' } },
    { type: 'content_block_stop' },
    { type: 'message_delta' },
    { type: 'error', error: { message: 'mid-stream boom' } },
    { type: 'error' },
    { type: 'message_stop' },
];

const STREAM_CASES = {
    full: ['claude-sonnet-4-6', HISTORY, { tools: TOOLS }, [fakeStream(STREAM_EVENTS, { stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } } })]],
    refusal: ['claude-opus-5', SHORT, {}, [fakeStream([{ type: 'message_start' }], { stop_reason: 'refusal', stop_details: { category: 'bio' } })]],
    refusalAfterText: ['claude-opus-5', SHORT, {}, [fakeStream([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }], { stop_reason: 'refusal', stop_details: null })]],
    contextWindow: ['claude-opus-5', SHORT, {}, [fakeStream([], { stop_reason: 'model_context_window_exceeded' })]],
    finalMessageThrows: ['claude-sonnet-4-6', SHORT, {}, [fakeStream([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } }], new Error('consumed'))]],
    noUsage: ['claude-sonnet-4-6', SHORT, {}, [fakeStream([], { stop_reason: 'end_turn' })]],
    contextMgmtRetry: ['claude-sonnet-4-6', SHORT, { tools: TOOLS }, [apiErr('context_management: unknown'), fakeStream([], { stop_reason: 'end_turn' })]],
    thinkingReplayRetry: ['claude-sonnet-4-6', HISTORY, {}, [apiErr('thinking block signature does not match'), fakeStream([], { stop_reason: 'end_turn' })]],
    forcedRetry: ['claude-sonnet-4-6', SHORT, { tools: TOOLS, toolChoice: 'any' }, [apiErr('tool_choice any is not supported'), fakeStream([], { stop_reason: 'end_turn' })]],
    errorEnriched: ['claude-sonnet-4-6', SHORT, {}, [apiErr('overloaded', 529)]],
    errorNoStatus: ['claude-sonnet-4-6', SHORT, {}, [new Error('socket hang up')]],
    oauth: ['claude-opus-4-8', SHORT, { tools: TOOLS }, [fakeStream([], { stop_reason: 'end_turn' })], 'sk-ant-oat-x'],
};

async function streamScenario() {
    const out = {};
    for (const [key, [model, msgs, opts, script, apiKey]] of Object.entries(STREAM_CASES)) {
        const p = new ClaudeProvider();
        const calls = [];
        p.createClient = () => fakeClient(calls, script.slice(calls.length));
        const events = [];
        let error = null;
        try { await p.stream(apiKey || 'sk-ant-api', null, model, clone(msgs), opts, (type, data) => events.push([type, clone(data)])); }
        catch (e) { error = { message: e.message, status: e.status ?? null }; }
        out[key] = { calls, events, error };
    }
    return out;
}

async function listModelsScenario() {
    const p = new ClaudeProvider();
    p.createClient = () => fakeClient([], [{ data: [{ id: 'a', display_name: 'A' }, { id: 'b' }] }]);
    const ok = await p.listModels('k');
    const q = new ClaudeProvider();
    q.createClient = () => fakeClient([], [new Error('down')]);
    const failed = await q.listModels('k');
    return { ok, failed };
}

let _collected = null;
async function collect() {
    if (_collected) return _collected;
    _collected = {
        helpers: helpersScenario(),
        params: paramsScenario(),
        chat: await chatScenario(),
        stream: await streamScenario(),
        listModels: await listModelsScenario(),
    };
    return _collected;
}

function loadOrWrite(actual) {
    if (process.env.UPDATE_GOLDEN === '1') {
        fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    }
    return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
}

for (const key of ['helpers', 'params', 'chat', 'stream', 'listModels']) {
    test(`golden: ${key}`, async () => {
        const actual = await collect();
        const golden = loadOrWrite(actual);
        assert.deepEqual(clone(actual[key]), golden[key]);
    });
}
