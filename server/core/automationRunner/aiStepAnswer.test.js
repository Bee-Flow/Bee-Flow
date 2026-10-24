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
const h = installAiStepHarness({
    realLlm: true,
    names: { 'Jan Jansen': '[person_1]' },
    adapterExtras: { supportsStructuredOutput: () => nativeStructured, supportsForcedToolChoice: () => true },
});
after(() => h.restore());
const { execAiStep } = h.load();
const { prepareAiAnswer, answerAiStep } = require('./aiStepAnswer');

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
