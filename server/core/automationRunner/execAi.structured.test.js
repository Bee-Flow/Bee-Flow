/**
 * execAiStep's STRUCTURED route: a step with a schema and no tools asks for its
 * answer through llmClient.chatForcedTool (native json_schema where the adapter
 * can enforce it, else a forced tool call) instead of JSON-in-the-prompt, and
 * uses the temperature the step names.
 *
 * Run: node --test core/automationRunner/execAi.structured.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installAiStepHarness, runStateWith } = require('../../testUtils/aiStepHarness');

const h = installAiStepHarness({
    extraStubs: {
        // Offers a tool when the step asks for one (a marker on the step), else none.
        './aiStepTools': {
            async resolveAiStepTools({ step }) {
                return { tools: step._tools || null, toolsWithheld: [], toolsWithheldReasons: {} };
            },
        },
        '../tools/toolDispatcher': { async executeTool() { return { ok: true }; } },
    },
});
after(() => h.restore());
const { execAiStep } = h.load();

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] } };
const step = (over = {}) => ({ id: 'ai_1', type: 'ai_step', prompt: 'Summarise.', inputs: {}, outputSchema: { digest: 'string' }, ...over });

beforeEach(() => {
    h.chatCalls.length = 0; h.forcedCalls.length = 0; h.usageRows.length = 0;
    h.forced = null;
    h.chat = async () => ({ content: '{"digest":"from chat"}', usage: {} });
});

test('a step with a schema and no tools asks chatForcedTool, not chat', async () => {
    h.forced = async () => ({ structured: { digest: 'short' }, content: null, usage: {} });
    const r = await execAiStep(step(), CTX, runStateWith(), 'live');
    assert.deepStrictEqual(r.output, { digest: 'short' });
    assert.strictEqual(h.forcedCalls.length, 1);
    assert.strictEqual(h.chatCalls.length, 0);
    const [call] = h.forcedCalls;
    assert.strictEqual(call.toolDef.function.name, 'step_answer');
    assert.deepStrictEqual(call.toolDef.function.parameters, { type: 'object', properties: { digest: { type: 'string' } } });
    assert.strictEqual(call.options.maxTokens, 4096);
    assert.strictEqual(call.options.reasoningEffort, 'none');
    assert.strictEqual(call.hadSignal, true, 'the run\'s cancel signal reaches the limiter');
    assert.match(call.messages.find((m) => m.role === 'user').content, /Return JSON matching this schema/, 'the schema text stays in the prompt');
    assert.strictEqual(r.checkReport, undefined, 'a step without checks reports none');
});

test('temperature is the step\'s own, 0.2 when it names none', async () => {
    h.forced = async () => ({ structured: { digest: 'x' }, usage: {} });
    await execAiStep(step(), CTX, runStateWith(), 'live');
    await execAiStep(step({ temperature: 0.7 }), CTX, runStateWith(), 'live');
    await execAiStep(step({ temperature: 0 }), CTX, runStateWith(), 'live');
    assert.deepStrictEqual(h.forcedCalls.map((c) => c.options.temperature), [0.2, 0.7, 0]);
});

test('the prompt route uses the same temperature', async () => {
    await execAiStep(step({ outputSchema: undefined, temperature: 1.1 }), { ...CTX, definition: { steps: [] } }, runStateWith(), 'live');
    assert.strictEqual(h.chatCalls[0].options.temperature, 1.1);
});

test('a flat { field: type } schema becomes object parameters', async () => {
    h.forced = async () => ({ structured: { n: 3, when: '2025-01-01T00:00:00Z' }, usage: {} });
    await execAiStep(step({ outputSchema: { n: 'number', when: 'datetime' } }), CTX, runStateWith(), 'live');
    assert.deepStrictEqual(h.forcedCalls[0].toolDef.function.parameters.properties, {
        n: { type: 'number' }, when: { type: 'string', format: 'date-time' },
    });
});

test('a structured answer null falls back to parsing the reply text', async () => {
    h.forced = async () => ({ structured: null, content: 'Sure:\n```json\n{"digest":"from text"}\n```', usage: {} });
    const r = await execAiStep(step(), CTX, runStateWith(), 'live');
    assert.deepStrictEqual(r.output, { digest: 'from text' });
});

test('no structured answer and no usable text still fails loudly', async () => {
    h.forced = async () => ({ structured: null, content: 'I cannot do that.', usage: {} });
    await assert.rejects(() => execAiStep(step(), CTX, runStateWith(), 'live'), (e) => e.errorClass === 'ValidationError' && /answered with something else/.test(e.message));
});

test('a schema that cannot be tool parameters takes the prompt route', async () => {
    await execAiStep(step({ outputSchema: { anyOf: [{ type: 'object' }] } }), CTX, runStateWith(), 'live');
    assert.strictEqual(h.forcedCalls.length, 0);
    assert.strictEqual(h.chatCalls.length, 1);
});

test('a step with tools takes the prompt route and its tool loop', async () => {
    const r = await execAiStep(step({ _tools: [{ type: 'function', function: { name: 'lookup' } }] }), CTX, runStateWith(), 'live');
    assert.strictEqual(h.forcedCalls.length, 0);
    assert.strictEqual(h.chatCalls.length, 1);
    assert.strictEqual(h.chatCalls[0].options.toolChoice, 'auto');
    assert.deepStrictEqual(r.output, { digest: 'from chat' });
});

test('one usage row, from the structured call', async () => {
    h.forced = async () => ({ structured: { digest: 'x' }, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    await execAiStep(step(), CTX, runStateWith(), 'live');
    assert.strictEqual(h.usageRows.length, 1);
    assert.strictEqual(h.usageRows[0].prompt_tokens, 10);
    assert.strictEqual(h.usageRows[0].source, 'automation');
});
