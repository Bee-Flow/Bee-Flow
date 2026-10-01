/**
 * An ai_step without an outputSchema answers in the fields later steps read
 * (collectAiStepOutputFields). Those reads are picks now (M5, the AI builder
 * writes them; the editor will too), which hold the step id and field as
 * data — the text scans for `steps.<id>.output.<field>` never saw them, so a
 * routine built with picks lost its inferred schema and its output.
 *
 * Also: the tier classifier reads a compose prompt as text, not as the
 * object it is stored as.
 *
 * Run: node --test core/automationRunner/execAi.pickReads.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { installResolveStub } = require('../../testUtils/stubRequire');

const classified = [];
const chatCalls = [];
const restore = installResolveStub({
    '../llm/modelResolver': { async getUserTierMap() { return { fast: { modelId: 'model-fast', maxTokens: 4096 } }; } },
    '../entitlements/userTiers': { async getPermittedTierKeys() { return null; } },
    '../llm/promptClassifier': { async classifyWithLLM(text) { classified.push(text); return { tier: 'fast' }; } },
    '../aiAgent': {
        async getProviderForModel(modelId) { return { apiKey: 'k', url: 'u', providerType: 'test', modelId }; },
        async getAIConfig() { return { model: 'model-fast' }; },
    },
    '../providers': {
        getAdapter: () => ({
            async chat(_key, _url, _modelId, messages) { chatCalls.push(messages); return { content: '{"digest":"ok"}', usage: {} }; },
        }),
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
    '../../stores/configStore': { async getConfig() { return null; } },
});
after(() => restore());

const { collectAiStepOutputFields, execAiStep } = require('./execAi');

const pick = (from, extra = {}) => ({ kind: 'pick', v: 1, from, take: 'one', as: 'native', ...extra });

test('a pick, a compose part and a ref of the step\'s output all name a field it must answer in', () => {
    const definition = {
        steps: [
            { id: 'ai1', type: 'ai_step', prompt: 'x' },
            { id: 'a2', type: 'integration_action', tool: 't', inputs: { to: pick({ root: 'steps', id: 'ai1', path: ['email'] }), other: { kind: 'ref', path: 'steps.ai1.output.subject' } } },
            {
                id: 'n1', type: 'notification',
                title: { kind: 'compose', v: 1, parts: ['Re: ', { from: { root: 'steps', id: 'ai1', path: ['subject'] }, take: 'one', as: 'text' }] },
                body: { kind: 'compose', v: 1, parts: [{ from: { root: 'steps', id: 'ai1', path: ['reply'] }, take: 'one', as: 'text' }] },
            },
            // A text field the old scan never looked at, and a step id that is not this one.
            { id: 'd1', type: 'generate_document', content: { kind: 'compose', v: 1, parts: [{ from: { root: 'steps', id: 'ai1', path: ['report'] }, take: 'one', as: 'text' }] } },
            { id: 'a3', type: 'integration_action', tool: 't', inputs: { x: pick({ root: 'steps', id: 'ai10', path: ['nope'] }) } },
        ],
    };
    const fields = collectAiStepOutputFields(definition, 'ai1');
    assert.deepEqual([...fields].sort(), ['email', 'reply', 'report', 'subject']);
});

test('the tier classifier is handed a compose prompt as text', async () => {
    classified.length = 0;
    const step = {
        id: 'ai1', type: 'ai_step', modelTier: 'auto', inputs: {},
        prompt: { kind: 'compose', v: 1, parts: ['Vat samen: ', { from: { root: 'trigger', path: ['tekst'] }, take: 'one', as: 'text' }] },
    };
    const state = { trigger: { output: { tekst: 'Hallo' } }, steps: {}, vars: {}, secrets: {}, loop: {} };
    await execAiStep(step, { userId: 'u1', orgId: 'o1', session: {}, definition: { steps: [step] } }, state, 'live');
    assert.deepEqual(classified, ['Vat samen: {{trigger.output.tekst}}']);
    const sent = chatCalls.flat().map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
    assert.ok(sent.includes('Vat samen: Hallo'), 'the model reads the rendered prompt');
});
