// @typecheck
/**
 * aiStepToolLoop.runAiStepChat: a tool loop that runs out of rounds ends on
 * ONE more call without tools that sees every tool result, the
 * structured one when the step declares a schema; every answered tool call is
 * tallied, failures included.
 *
 * The provider limiter, the dispatcher, the guards and the egress probe are
 * stubbed; the loop itself and the transcript flattening are real.
 *
 * Run: cd server && node --test core/automationRunner/aiStepToolLoop.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const clone = (/** @type {unknown} */ v) => JSON.parse(JSON.stringify(v));

/** @type {{ sends: any[], dispatched: any[], toolResult: unknown, reply: (msgs: any[], options: any) => any }} */
const fx = { sends: [], dispatched: [], toolResult: null, reply: () => ({ content: 'done' }) };

/**
 * Replace exports of the real modules for this file. The loop reads them off
 * the module object (or destructures them when it loads), so patching before
 * the loop is required, and putting back afterwards, is enough.
 * @param {Record<string, any>} mod
 * @param {Record<string, any>} over
 * @returns {() => void}
 */
function patchExports(mod, over) {
    const saved = Object.fromEntries(Object.keys(over).map((k) => [k, mod[k]]));
    Object.assign(mod, over);
    return () => Object.assign(mod, saved);
}

const restores = [
    patchExports(require('../llm/providerLimiter'), {
        async limitedChat({ messages, options }) {
            fx.sends.push({ messages: clone(messages), options: clone(options) });
            return fx.reply(messages, options);
        },
    }),
    patchExports(require('../tools/toolDispatcher'), {
        async executeTool(name, args) { fx.dispatched.push({ name, args }); return fx.toolResult; },
    }),
    patchExports(require('./safety'), {
        async guardToolInput(args) { return { value: args }; },
        prepareForEgress: (value) => value,
        async guardToolOutput(result) { return { result }; },
        async logEgress() {},
    }),
    patchExports(require('../http/outboundProbe'), { runWithProbe: async (fn) => ({ result: await fn(), probe: null }), markLocal: () => {} }),
    patchExports(require('../integrations/integrationToolMap'), { resolveIntegration: () => null }),
    patchExports(require('../privacy/toolPiiGate'), { toolLoopGate: () => ({ refuse: async () => null, forModel: async (text) => text }) }),
    patchExports(require('../../stores/guardrailEventStore'), { async logGuardrailEvent() {} }),
];
after(() => restores.forEach((r) => r()));

const { runAiStepChat, MAX_AI_STEP_TOOL_ITERATIONS, WRAP_UP_MESSAGE, isFailedToolResult } = require('./aiStepToolLoop');

const SEARCH_TOOL = { type: 'function', function: { name: 'agent_search', description: 'web', parameters: { type: 'object', properties: { query: { type: 'string' } } } } };
const ANSWER_TOOL = { type: 'function', function: { name: 'step_answer', parameters: { type: 'object', properties: { digest: { type: 'string' } } } } };
let callSeq = 0;
const searchCall = () => ({ id: `call_${++callSeq}`, type: 'function', function: { name: 'agent_search', arguments: '{"query":"weer Amsterdam"}' } });

/** A model that asks for a search on every round that offers tools, and answers otherwise. */
const alwaysSearches = (/** @type {any[]} */ _msgs, /** @type {any} */ options) => (options.tools
    ? { content: '', toolCalls: [searchCall()], usage: {} }
    : { content: '{"digest":"from the results"}', usage: {} });

/** @param {Record<string, unknown>} [over] */
function call(over = {}) {
    return {
        adapter: { name: 'test' }, cfg: { url: 'https://llm.example.test', apiKey: 'k' }, modelId: 'model-fast',
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Find the weather.' }],
        maxOutputTokens: 4096, temperature: 0.2, tools: [SEARCH_TOOL], accrueUsage: () => {},
        step: { id: 'ai_1' }, ctx: { userId: 'u1', orgId: 'org1' }, mode: 'live', policy: { action: 'off' }, auditBase: {},
        agentBinding: null,
        ...over,
    };
}

beforeEach(() => {
    fx.sends = []; fx.dispatched = []; fx.toolResult = '# Search Results\n\nZonnig, 18 graden.'; fx.reply = alwaysSearches;
});

test('a loop that hits the cap ends on one call without tools that reads every tool result', async () => {
    fx.toolResult = { error: 'Search failed: timeout after 30 s' };
    const r = await runAiStepChat(/** @type {any} */ (call()));
    assert.strictEqual(fx.sends.length, MAX_AI_STEP_TOOL_ITERATIONS + 1);
    assert.ok(fx.sends.slice(0, -1).every((s) => s.options.tools), 'the loop rounds offer the tools');
    const last = fx.sends[fx.sends.length - 1];
    assert.strictEqual(last.options.tools, undefined, 'the final call offers no tools');
    assert.strictEqual(last.options.toolChoice, undefined);
    assert.strictEqual(last.options.maxTokens, 4096);
    // The tool round trips go as text: no request with tool calls and no tools.
    assert.ok(last.messages.every((m) => m.role !== 'tool' && !m.tool_calls));
    const results = last.messages.filter((m) => typeof m.content === 'string' && m.content.startsWith('[Result of tool agent_search]'));
    assert.strictEqual(results.length, MAX_AI_STEP_TOOL_ITERATIONS);
    assert.match(results[0].content, /timeout after 30 s/);
    assert.deepStrictEqual(last.messages[last.messages.length - 1], { role: 'user', content: WRAP_UP_MESSAGE });

    assert.strictEqual(r.hitIterationCap, true);
    assert.strictEqual(r.response.content, '{"digest":"from the results"}');
    assert.strictEqual(r.toolTally.length, MAX_AI_STEP_TOOL_ITERATIONS);
    assert.ok(r.toolTally.every((t) => t.name === 'agent_search' && t.error === 'Search failed: timeout after 30 s'));
});

test('with an answer tool (a declared schema) the final call is the forced structured one', async () => {
    const forced = [];
    const llmClient = {
        async chatForcedTool(modelId, messages, toolDef, options) {
            forced.push({ modelId, messages: clone(messages), toolDef, options });
            return { structured: { digest: 'zonnig' }, content: null, usage: {}, stopReason: 'stop' };
        },
    };
    const signal = new AbortController().signal;
    const r = await runAiStepChat(/** @type {any} */ (call({ answerTool: ANSWER_TOOL, llmClient, ctx: { userId: 'u1', cancelSignal: signal } })));
    assert.strictEqual(fx.sends.length, MAX_AI_STEP_TOOL_ITERATIONS, 'no plain call after the loop');
    assert.strictEqual(forced.length, 1);
    assert.strictEqual(forced[0].toolDef, ANSWER_TOOL);
    assert.strictEqual(forced[0].modelId, 'model-fast');
    assert.strictEqual(forced[0].options.rateLimit.signal, signal);
    assert.ok(forced[0].messages.some((m) => typeof m.content === 'string' && m.content.includes('Zonnig, 18 graden.')));
    assert.ok(forced[0].messages.every((m) => m.role !== 'tool'));
    assert.deepStrictEqual(r.response.structured, { digest: 'zonnig' });
    assert.strictEqual(r.response.content, '');
    assert.strictEqual(r.hitIterationCap, true);
    assert.ok(r.toolTally.every((t) => t.error === null), 'a search that answered is not a failure');
});

test('a loop the model ends itself makes no extra call', async () => {
    let round = 0;
    fx.reply = () => (++round === 1 ? { content: '', toolCalls: [searchCall()] } : { content: 'Zonnig.' });
    const r = await runAiStepChat(/** @type {any} */ (call()));
    assert.strictEqual(fx.sends.length, 2);
    assert.strictEqual(r.hitIterationCap, false);
    assert.strictEqual(r.response.content, 'Zonnig.');
    assert.deepStrictEqual(r.toolTally, [{ name: 'agent_search', error: null }]);
});

test('a tool outside the offered set is tallied as a failed call', async () => {
    let round = 0;
    fx.reply = () => (++round === 1
        ? { content: '', toolCalls: [{ id: 'x1', function: { name: 'gmail_send', arguments: '{}' } }] }
        : { content: 'Klaar.' });
    const r = await runAiStepChat(/** @type {any} */ (call()));
    assert.strictEqual(fx.dispatched.length, 0);
    assert.strictEqual(r.toolTally[0].name, 'gmail_send');
    assert.match(String(r.toolTally[0].error), /not in the permitted tool set/);
});

test('isFailedToolResult: the { error } convention and the plain search-failure text', () => {
    assert.strictEqual(isFailedToolResult({ error: 'boom' }), true);
    assert.strictEqual(isFailedToolResult('Search failed: timeout after 30 s'), true);
    assert.strictEqual(isFailedToolResult('# Search Results'), false);
    assert.strictEqual(isFailedToolResult({ results: [] }), false);
    assert.strictEqual(isFailedToolResult(null), false);
});
