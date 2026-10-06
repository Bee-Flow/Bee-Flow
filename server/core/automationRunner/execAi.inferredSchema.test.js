/**
 * A schemaless AI step is asked for the SHAPE later steps read, not for
 * "string" fields (aiOutputInference.js).
 *
 * The model reads "Return JSON matching this schema" literally. When every
 * inferred field was "string", a model that obeyed returned a string where a
 * later step looped over a list or read a nested field, and the run was
 * green with an empty loop and blank mappings.
 *
 * Run: node --test core/automationRunner/execAi.inferredSchema.test.js
 */
'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { installResolveStub } = require('../../testUtils/stubRequire');

const calls = [];
let reply = '{}';

const restore = installResolveStub({
    '../llm/modelResolver': { async getUserTierMap() { return { fast: { modelId: 'model-fast', maxTokens: 4096 } }; } },
    '../entitlements/userTiers': { async getPermittedTierKeys() { return null; } },
    '../llm/promptClassifier': { async classifyWithLLM() { return { tier: 'fast' }; } },
    '../aiAgent': {
        async getProviderForModel(modelId) { return { apiKey: 'k', url: 'u', providerType: 'test', modelId }; },
        async getAIConfig() { return { model: 'model-fast' }; },
    },
    '../providers': {
        getAdapter: () => ({
            async chat(_key, _url, _modelId, messages) {
                calls.push(messages);
                return { content: reply, usage: {} };
            },
        }),
    },
    '../../automation/bind': {
        resolveInputs: (inputs) => JSON.parse(JSON.stringify(inputs || {})),
        interpolateTemplate: (s) => s,
    },
    './safety': {
        async resolveAutomationPolicy() { return { action: 'off' }; },
        buildAuditBase() { return {}; },
        async guardAiInput() { return { blocked: false }; },
        async guardAiOutput(content) { return { content }; },
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    '../../stores/usageStore': { async logUsage() {} },
    '../../stores/terminationStore': { async logTermination() {} },
});
after(() => restore());

const { execAiStep, collectAiStepOutputFields } = require('./execAi');

const DEFINITION = {
    steps: [
        { id: 'ai_1', type: 'ai_step', prompt: 'Extract the order.' },
        { id: 'each', type: 'integration_action', tool: 'create_line', forEach: { overRef: 'steps.ai_1.output.line_items', itemVar: 'line' },
            inputs: { sku: { kind: 'ref', path: 'loop.line.sku' } } },
        { id: 'mail', type: 'integration_action', tool: 'send', inputs: {
            to: { kind: 'ref', path: 'steps.ai_1.output.customer.contacts[0].email' },
            note: { kind: 'template', value: '{{steps.ai_1.output.note}}' },
            points: { kind: 'expr', value: 'steps.ai_1.output["Story Points"]' },
        } },
    ],
};
const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: DEFINITION };
const step = { id: 'ai_1', type: 'ai_step', prompt: 'Extract the order.', inputs: {} };
const userText = () => calls[0].find(m => m.role === 'user').content;

beforeEach(() => { calls.length = 0; reply = '{}'; });

test('the model is asked for lists and nested records where later steps read them', async () => {
    reply = JSON.stringify({ line_items: [{ sku: 'a' }], customer: { contacts: [{ email: 'x@y' }] }, note: 'n', 'Story Points': 3 });
    const r = await execAiStep(step, CTX, {}, 'live');
    const m = /Return JSON matching this schema[^\n]*\n(.+)$/m.exec(userText());
    assert.ok(m, 'the schema line is there');
    const schema = JSON.parse(m[1]);
    assert.deepEqual(schema.properties.line_items, { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } });
    assert.deepEqual(schema.properties.customer, {
        type: 'object',
        properties: { contacts: { type: 'array', items: { type: 'object', properties: { email: { type: 'string' } } } } },
    });
    assert.deepEqual(schema.properties['Story Points'], { type: 'string' }, 'a bracket read is a field too');
    assert.equal(r.output.customer.contacts[0].email, 'x@y');
    assert.equal(r.outputSchemaSource, 'inferred');
});

test('prose is wrapped under the first TEXT field, not under a list', async () => {
    reply = 'Sorry, plain words.';
    const r = await execAiStep(step, CTX, {}, 'live');
    assert.deepEqual(r.output, { note: 'Sorry, plain words.' });
});

test('collectAiStepOutputFields keeps its contract: the top-level names, first seen first', () => {
    assert.deepEqual(collectAiStepOutputFields(DEFINITION, 'ai_1'), ['line_items', 'customer', 'note', 'Story Points']);
});
