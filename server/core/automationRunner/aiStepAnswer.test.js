// @typecheck
/**
 * aiStepAnswer: the routes to the model and the reuse seam, with the real
 * llmClient and provider limiter on top of a fake adapter (an adapter that can
 * enforce a schema natively, as EU GPT does), and with injected deps.
 *
 * Run: node --test core/automationRunner/aiStepAnswer.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installAiStepHarness, runStateWith } = require('../../testUtils/aiStepHarness');

let nativeStructured = true;
/** What the tool loop's dispatcher answers (answerAiStep with tools, below). */
const tools = { result: /** @type {unknown} */ (null), dispatched: 0 };
const h = installAiStepHarness({
    realLlm: true,
    names: { 'Jan Jansen': '[person_1]' },
    adapterExtras: { supportsStructuredOutput: () => nativeStructured, supportsForcedToolChoice: () => true },
    extraStubs: {
        '../tools/toolDispatcher': { async executeTool() { tools.dispatched += 1; return tools.result; } },
        '../http/outboundProbe': { runWithProbe: async (fn) => ({ result: await fn(), probe: null }), markLocal: () => {} },
        '../integrations/integrationToolMap': { resolveIntegration: () => null },
        '../privacy/toolPiiGate': { toolLoopGate: () => ({ refuse: async () => null, forModel: async (text) => text }) },
        '../../stores/guardrailEventStore': { async logGuardrailEvent() {} },
    },
});
after(() => h.restore());
const { execAiStep } = h.load();
const { prepareAiAnswer, answerAiStep } = require('./aiStepAnswer');
const { MAX_AI_STEP_TOOL_ITERATIONS } = require('./aiStepToolLoop');
// The harness's guard has no tool half: the tool loop's guards pass everything through here.
Object.assign(require('./safety'), {
    async guardToolInput(args) { return { value: args }; },
    prepareForEgress: (value) => value,
    async guardToolOutput(result) { return { result }; },
    async logEgress() {},
});

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] }, cancelSignal: new AbortController().signal };
const step = (over = {}) => ({ id: 'ai_1', type: 'ai_step', prompt: 'Summarise.', inputs: {}, outputSchema: { digest: 'string' }, ...over });

beforeEach(() => {
    h.chatCalls.length = 0; h.usageRows.length = 0; nativeStructured = true;
    h.chat = async () => ({ content: '{"digest":"native"}', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
});

test('an adapter that enforces schemas natively gets json_schema, through the real llmClient', async () => {
    const r = await execAiStep(step({ temperature: 0.4 }), CTX, runStateWith(), 'live');
    assert.deepStrictEqual(r.output, { digest: 'native' });
    assert.strictEqual(h.chatCalls.length, 1);
    const { options } = h.chatCalls[0];
    assert.strictEqual(options.responseFormat.type, 'json_schema');
    assert.strictEqual(options.responseFormat.json_schema.name, 'step_answer');
    assert.deepStrictEqual(options.responseFormat.json_schema.schema.properties, { digest: { type: 'string' } });
    assert.strictEqual(options.temperature, 0.4);
    assert.strictEqual(options.maxTokens, 4096);
    assert.strictEqual(h.chatCalls[0].forwardedRateLimit, false, 'rateLimit is for the client, never for the adapter');
    assert.strictEqual(options.tools, undefined);
    assert.strictEqual(h.usageRows[0].prompt_tokens, 3);
});

test('an adapter without native support gets a forced tool call and the answer is read from it', async () => {
    nativeStructured = false;
    h.chat = async () => ({
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'step_answer', arguments: '{"digest":"from tool"}' } }],
        usage: {},
    });
    const r = await execAiStep(step(), CTX, runStateWith(), 'live');
    assert.deepStrictEqual(r.output, { digest: 'from tool' });
    const { options } = h.chatCalls[0];
    assert.strictEqual(options.tools[0].function.name, 'step_answer');
    assert.strictEqual(options.responseFormat, undefined);
});

test('allowEmpty reaches the native schema: the allowed values plus the empty text', async () => {
    const rs = runStateWith({ src: { names: ['alpha', 'beta'] } });
    h.chat = async () => ({ content: '{"digest":"alpha"}', usage: {} });
    const enumFrom = (allowEmpty) => [{ field: 'digest', ref: 'steps.src.output.names', ...(allowEmpty ? { allowEmpty: true } : {}) }];
    await execAiStep(step({ enumFrom: enumFrom(true) }), CTX, rs, 'live');
    assert.deepStrictEqual(h.chatCalls[0].options.responseFormat.json_schema.schema.properties.digest.enum, ['alpha', 'beta', '']);
    h.chatCalls.length = 0;
    await execAiStep(step({ enumFrom: enumFrom(false) }), CTX, rs, 'live');
    assert.deepStrictEqual(h.chatCalls[0].options.responseFormat.json_schema.schema.properties.digest.enum, ['alpha', 'beta']);
});

test('a run that is cancelled while waiting for the provider does not call it', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => execAiStep(step(), { ...CTX, cancelSignal: controller.signal }, runStateWith(), 'live'), /Run cancelled|aborted/i);
    assert.strictEqual(h.chatCalls.length, 0);
});

test('prepareAiAnswer appends one allowed-values message only when there is something to send', () => {
    const rs = runStateWith({ src: { names: ['Jan Jansen', 'Piet'] } });
    const base = () => [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];

    const none = base();
    const noneRel = prepareAiAnswer({ step: step(), runState: rs, ctx: CTX, mode: 'live', messages: none });
    assert.strictEqual(none.length, 2);
    assert.strictEqual(noneRel.rel.active, false);
    assert.strictEqual(noneRel.listsMessage, null);

    const withList = base();
    const prep = prepareAiAnswer({ step: step({ enumFrom: [{ field: 'digest', ref: 'steps.src.output.names' }] }), runState: rs, ctx: CTX, mode: 'live', messages: withList });
    assert.strictEqual(withList.length, 3);
    assert.strictEqual(withList[2], prep.listsMessage);
    assert.strictEqual(prep.rel.active, true);
    assert.strictEqual(prep.lists[0].values.length, 2);
});

test('answerAiStep takes injected llmClient and cache', async () => {
    const asked = [];
    const stored = [];
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
    const s = step({ askOnce: true });
    const prep = prepareAiAnswer({ step: s, runState: runStateWith(), ctx: CTX, mode: 'live', messages });
    const contract = { effectiveSchema: s.outputSchema, inferred: null, inferredFields: null, outputContract: { declared: true, source: 'step' } };
    const call = {
        step: s, ctx: CTX, runState: runStateWith(), mode: 'live', policy: { action: 'tokenize' }, auditBase: {},
        messages, tools: null, contract, prep, agentBinding: null,
        model: { adapter: { name: 'test' }, cfg: { url: 'https://llm.example.test', apiKey: 'k' }, modelId: 'm', maxOutputTokens: 100, stepReasoningEffort: undefined },
    };
    const deps = {
        llmClient: { async chatForcedTool(modelId, msgs, toolDef, options) { asked.push({ modelId, toolDef, options }); return { structured: { digest: 'injected' }, usage: {} }; } },
        cache: {
            async planAiReuse() { return { plan: true }; },
            async readAiReuse() { return { reused: null }; },
            rememberAiAnswer(plan, args) { stored.push(args); },
        },
    };
    const out = await answerAiStep(call, deps);
    assert.deepStrictEqual(out.output, { digest: 'injected' });
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].options.rateLimit.signal, CTX.cancelSignal);
    assert.deepStrictEqual(stored[0].answer, { content: null, structured: { digest: 'injected' } });
    assert.strictEqual(out.checkReport, undefined);
});

// ── A declared schema is a contract, also on the tool route ─────

const SEARCH_TOOL = { type: 'function', function: { name: 'agent_search', description: 'web', parameters: { type: 'object', properties: { query: { type: 'string' } } } } };
const declared = (schema) => ({ effectiveSchema: schema, inferred: null, inferredFields: null, outputContract: { declared: true, source: 'step' } });

/**
 * answerAiStep on a fake adapter (the loop rounds and the repair) and an
 * injected llmClient (the structured calls). `reply(messages, options)` answers the adapter.
 */
async function answerWith({ s = step(), withTools = true, reply, forced }) {
    const sent = [];
    const forcedCalls = [];
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'Find the weather.' }];
    const prep = prepareAiAnswer({ step: s, runState: runStateWith(), ctx: CTX, mode: 'live', messages });
    const adapter = {
        name: 'test',
        async chat(_k, _u, _m, msgs, options) { sent.push({ messages: JSON.parse(JSON.stringify(msgs)), options }); return reply(msgs, options); },
    };
    const call = {
        step: s, ctx: CTX, runState: runStateWith(), mode: 'live', policy: { action: 'off' }, auditBase: {},
        messages, tools: withTools ? [SEARCH_TOOL] : null, contract: declared(s.outputSchema), prep, agentBinding: null,
        model: { adapter, cfg: { url: 'https://llm.example.test', apiKey: 'k' }, modelId: 'm', maxOutputTokens: 100, stepReasoningEffort: undefined },
    };
    const llmClient = {
        async chatForcedTool(modelId, msgs, toolDef, options) {
            forcedCalls.push({ messages: JSON.parse(JSON.stringify(msgs)), toolDef, options });
            return forced(msgs);
        },
    };
    const result = await answerAiStep(call, { llmClient });
    return { result, sent, forcedCalls };
}

let seq = 0;
const searchRound = () => ({ content: '', toolCalls: [{ id: `c${++seq}`, type: 'function', function: { name: 'agent_search', arguments: '{"query":"weer"}' } }], usage: {} });
const alwaysSearch = (_msgs, options) => (options.tools ? searchRound() : { content: '', usage: {} });

test('a declared schema answered with {} fails the step', async () => {
    await assert.rejects(
        () => answerWith({ withTools: false, reply: () => ({ content: '' }), forced: () => ({ structured: {}, content: '{}', usage: {} }) }),
        (/** @type {any} */ e) => {
            assert.strictEqual(e.errorClass, 'ValidationError');
            assert.match(e.message, /does not match its declared output schema/);
            assert.match(e.message, /empty object \(tool calls: 0, failed: 0, iteration cap hit: no\)/);
            return true;
        },
    );
});

test('all fields empty after every web search failed: the step fails and says why', async () => {
    tools.result = { error: 'Search failed: timeout after 30 s' };
    tools.dispatched = 0;
    await assert.rejects(
        () => answerWith({ reply: alwaysSearch, forced: () => ({ structured: { digest: '' }, content: null, usage: {} }) }),
        (/** @type {any} */ e) => {
            assert.strictEqual(e.errorClass, 'ValidationError');
            assert.strictEqual(e.message, `All ${MAX_AI_STEP_TOOL_ITERATIONS} web searches failed (timeout after 30 s); the model returned no data.`);
            return true;
        },
    );
    assert.strictEqual(tools.dispatched, MAX_AI_STEP_TOOL_ITERATIONS);
});

test('the capped loop ends on the forced step_answer call, which reads the tool results', async () => {
    tools.result = '# Search Results\n\nZonnig, 18 graden.';
    const { result, sent, forcedCalls } = await answerWith({ reply: alwaysSearch, forced: () => ({ structured: { digest: 'Zonnig' }, content: null, usage: {} }) });
    assert.deepStrictEqual(result.output, { digest: 'Zonnig' });
    assert.strictEqual(sent.length, MAX_AI_STEP_TOOL_ITERATIONS);
    assert.strictEqual(forcedCalls.length, 1);
    assert.strictEqual(forcedCalls[0].toolDef.function.name, 'step_answer');
    assert.ok(forcedCalls[0].messages.some((m) => typeof m.content === 'string' && m.content.includes('Zonnig, 18 graden.')));
});

test('all fields empty while the searches worked: an empty result can be the real answer', async () => {
    tools.result = '# Search Results\n\nNiets gevonden over dit onderwerp.';
    let round = 0;
    const { result } = await answerWith({
        reply: () => (++round === 1 ? searchRound() : { content: '{"digest":""}', usage: {} }),
        forced: () => { throw new Error('no forced call: the loop ended by itself'); },
    });
    assert.deepStrictEqual(result.output, { digest: '' });
});

test('the repair round sees the tool results of the first round, as text', async () => {
    tools.result = '# Search Results\n\nZonnig, 18 graden.';
    let round = 0;
    const s = step({ checks: [{ kind: 'script', field: 'digest', script: 'latin' }] });
    const { result, sent } = await answerWith({
        s,
        reply: () => {
            round += 1;
            if (round === 1) return searchRound();
            return { content: round === 2 ? '{"digest":"Солнечно"}' : '{"digest":"Zonnig"}', usage: {} };
        },
        forced: () => { throw new Error('no forced call'); },
    });
    assert.deepStrictEqual(result.output, { digest: 'Zonnig' });
    assert.strictEqual(result.checkReport.repaired, true);
    const repair = sent[sent.length - 1];
    assert.strictEqual(repair.options.tools, undefined, 'the repair offers no tools');
    assert.ok(repair.messages.every((m) => m.role !== 'tool' && !m.tool_calls), 'no tool round trips without tools');
    assert.ok(repair.messages.some((m) => typeof m.content === 'string' && m.content.includes('Zonnig, 18 graden.')), 'the search result is in the repair');
    assert.match(repair.messages[repair.messages.length - 1].content, /^Your answer did not pass these checks/);
});

test('an empty reply is never an answer, also without a schema', async () => {
    h.chat = async () => ({ content: '   ', usage: {} });
    await assert.rejects(
        () => execAiStep(step({ outputSchema: undefined }), CTX, runStateWith(), 'live'),
        (/** @type {any} */ e) => {
            assert.strictEqual(e.errorClass, 'ValidationError');
            assert.strictEqual(e.message, 'The model returned no answer (tool calls: 0, failed: 0, iteration cap hit: no).');
            return true;
        },
    );
});
