/**
 * BFSF-354 — an AI step's tool loop (execAiStep with allowTools) honours the
 * Privacy Shield's tool block lists, the way chat does: a call whose
 * arguments carry a category on the "Outside tools" / "Own server" list is
 * refused, and what the model reads of a result has those categories
 * stripped. The shield is the automation policy's (safety.resolveAutomationPolicy),
 * which is null when the org keeps automations out of the shield ("Also protect
 * automations" off), so that switch holds for the lists too.
 *
 * The step's collaborators are stubbed through testUtils/stubRequire (the
 * pattern of execAi.kb.test.js); the real gate runs with its detector
 * injected and the real orgShield classifies the tools. Synthetic data.
 *
 * Run: cd server && node --test core/automationRunner/execAi.toolPiiGate.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, REFUSED_FOR_EMAIL, configStoreStub, injectEmailDetector, assertStripped,
} = require('../../testUtils/toolPiiGateHarness');

const fx = { shield: null, toolCall: null, dispatchResult: null, dispatched: [], guardrailRows: [], toolMessages: [] };

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
            // Round 1 asks for fx.toolCall; round 2 records the tool answer it read.
            async chat(_key, _url, _model, messages) {
                const toolMsgs = messages.filter(m => m.role === 'tool');
                if (toolMsgs.length === 0) {
                    return { content: '', toolCalls: [{ id: 'call_1', function: { name: fx.toolCall.name, arguments: JSON.stringify(fx.toolCall.args) } }], usage: {} };
                }
                fx.toolMessages.push(...toolMsgs);
                return { content: 'done', usage: {} };
            },
        }),
    },
    '../../automation/bind': {
        resolveInputs: (inputs) => JSON.parse(JSON.stringify(inputs || {})),
        interpolateTemplate: (s) => s,
    },
    './safety': {
        async resolveAutomationPolicy() { return { action: 'off', shield: fx.shield }; },
        buildAuditBase() { return { organization_id: 'org1', automation_id: 'auto-1', source: 'automation' }; },
        async guardAiInput() { return { blocked: false }; },
        async guardAiOutput(content) { return { content }; },
        async guardToolInput(args) { return { value: args }; },
        prepareForEgress: (value) => value,
        async guardToolOutput(result) { return { result }; },
        async logEgress() {},
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    '../http/outboundProbe': {
        runWithProbe: async (fn) => ({ result: await fn(), probe: null }),
        markLocal: () => {},
    },
    '../integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [{ type: 'function', function: { name: fx.toolCall.name, parameters: {} } }] }),
    },
    '../tools/toolDispatcher': {
        executeTool: async (name, args) => { fx.dispatched.push({ name, args }); return fx.dispatchResult; },
    },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    '../../stores/usageStore': { async logUsage() {} },
    '../../stores/terminationStore': { async logTermination() {} },
    // aiStepModel reads its override here, and the real orgShield (loaded by
    // the gate for the tool classification) its config.
    '../../stores/configStore': configStoreStub(),
});
after(() => restore());

injectEmailDetector(require('../privacy/toolPiiGate'));

const { execAiStep } = require('./execAi');

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] } };

beforeEach(() => {
    Object.assign(fx, { shield: OWN_SERVER_EMAIL, dispatchResult: { ok: true }, dispatched: [], guardrailRows: [], toolMessages: [] });
});

const runStep = (mode = 'live') => execAiStep(
    { id: 'ai_1', type: 'ai_step', prompt: 'Find the contact.', inputs: {}, allowTools: true, modelTier: 'fast' },
    CTX, {}, mode,
);

test('a tool whose arguments carry an own-server category is refused, never dispatched', async () => {
    fx.toolCall = { name: 'kb_search', args: { query: `mail from ${SYNTH_EMAIL}` } };
    await runStep();
    assert.strictEqual(fx.dispatched.length, 0, 'a refused tool must not be dispatched');
    assert.match(fx.toolMessages[0].content, REFUSED_FOR_EMAIL);
    assert.strictEqual(fx.guardrailRows[0].action_taken, 'tool_blocked');
    assert.strictEqual(fx.guardrailRows[0].automation_id, 'auto-1', 'filed like the automation\'s own rows');
    assert.strictEqual(fx.guardrailRows[0].step_id, 'ai_1:kb_search');
});

test('an own-server category in a result is stripped before the model reads it', async () => {
    fx.toolCall = { name: 'kb_search', args: { query: 'contact' } };
    fx.dispatchResult = { passage: `reach ${SYNTH_EMAIL}` };
    await runStep();
    assert.strictEqual(fx.dispatched.length, 1);
    assertStripped(fx.toolMessages[0].content);
    assert.ok(fx.guardrailRows.some(r => r.action_taken === 'tool_result_redacted'));
});

test('automations kept out of the shield (no policy shield): nothing is refused or stripped', async () => {
    fx.shield = null;
    fx.toolCall = { name: 'kb_search', args: { query: SYNTH_EMAIL } };
    fx.dispatchResult = { passage: SYNTH_EMAIL };
    await runStep();
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));
    assert.deepStrictEqual(fx.guardrailRows, []);
});

test('an outside tool is held to the outside list only', async () => {
    fx.toolCall = { name: 'agent_search', args: { query: SYNTH_EMAIL } };
    await runStep();
    assert.strictEqual(fx.dispatched.length, 1);

    fx.shield = { ...OWN_SERVER_EMAIL, toolPiiPolicy: { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } } };
    fx.dispatched = [];
    fx.toolMessages = [];
    await runStep();
    assert.strictEqual(fx.dispatched.length, 0);
    assert.match(fx.toolMessages[0].content, /forbids sending to external tools/);
});
