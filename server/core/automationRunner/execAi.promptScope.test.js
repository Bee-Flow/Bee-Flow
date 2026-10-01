/**
 * An ai_step's prompt scope: the runtime roots win over the step's input names.
 *
 * The confirmed scenario: the scope was `{ ...runState, secrets: {},
 * ...resolvedInputs }`, so an input named `trigger` (or steps/vars/loop)
 * replaced that root, and `{{trigger.output.subject}}` in the prompt reached
 * the model as literal braces (leaveUnresolved) or read the input's value.
 *
 * Run: node --test core/automationRunner/execAi.promptScope.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const chatCalls = [];

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
            async chat(_key, _url, modelId, messages) {
                chatCalls.push(messages);
                return { content: 'ok', usage: {} };
            },
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
});
after(() => restore());

const { execAiStep, aiPromptScope } = require('./execAi');

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] } };

beforeEach(() => { chatCalls.length = 0; });

function sentText() {
    return chatCalls.flat().map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}

test('an input named after a root no longer hides that root from the prompt', async () => {
    const runState = { trigger: { output: { subject: 'Hi' } }, steps: {}, vars: {}, loop: {}, secrets: {}, _templateWarnings: [] };
    await execAiStep({
        id: 'ai_1', type: 'ai_step',
        prompt: 'S={{trigger.output.subject}} F={{from}}',
        inputs: { trigger: { kind: 'literal', value: 'some text' }, from: { kind: 'literal', value: 'ada@example.org' } },
    }, CTX, runState, 'live');
    const text = sentText();
    assert.match(text, /S=Hi F=ada@example\.org/, text);
    assert.doesNotMatch(text, /\{\{trigger\.output\.subject\}\}/);
});

test('aiPromptScope: roots from the run state, other inputs by name, never secrets', () => {
    const runState = { trigger: { output: { a: 1 } }, steps: { s: {} }, vars: { v: 1 }, loop: { row: {} }, secrets: { key: 'x' }, _templateWarnings: [] };
    const scope = aiPromptScope(runState, { trigger: 't', steps: 's', vars: 'v', loop: 'l', secrets: 'leak', from: 'a', subject: 'b' });
    assert.deepStrictEqual(scope.trigger, runState.trigger);
    assert.deepStrictEqual(scope.steps, runState.steps);
    assert.deepStrictEqual(scope.vars, runState.vars);
    assert.deepStrictEqual(scope.loop, runState.loop);
    assert.deepStrictEqual(scope.secrets, {}, 'secrets are stripped, and an input cannot put a value there either');
    assert.strictEqual(scope.from, 'a');
    assert.strictEqual(scope.subject, 'b');
    assert.strictEqual(scope._templateWarnings, runState._templateWarnings, 'misses still land on the run\'s warning list');
    assert.ok(!('loop' in aiPromptScope({ trigger: {} }, { loop: 'l' })), 'a root the run lacks is not filled from an input');
});
