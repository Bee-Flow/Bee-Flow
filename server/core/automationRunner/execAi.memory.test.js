/**
 * execAiStep's personal-memory grounding (`step.useMemory`, 2026-09-04).
 *
 * Same harness as execAi.kb.test.js. The properties: the block is keyed off
 * ctx.userId (the automation OWNER — an automation has no app-level owner), it
 * rides in the system prompt before the safety tail, it is scrubbed by the
 * read-time PII guard, and a step without the flag never touches the store.
 *
 * Run: node --test --test-force-exit core/automationRunner/execAi.memory.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const TIERS = { fast: { modelId: 'model-fast', maxTokens: 4096 } };
const guardAiInputCalls = [];
const memoryCalls = [];
const scrubCalls = [];
let memories = [];
let policy = { read: true, write: true, reason: 'enabled' };
const policyCalls = [];
let piiDetectionEnabled = true;

const restore = installResolveStub({
    '../llm/modelResolver': { async getUserTierMap() { return TIERS; } },
    '../entitlements/userTiers': { async getPermittedTierKeys() { return null; } },
    '../llm/promptClassifier': { async classifyWithLLM() { return { tier: 'fast' }; } },
    '../aiAgent': {
        async getProviderForModel(modelId) { return { apiKey: 'k', url: 'u', providerType: 'test', modelId }; },
        async getAIConfig() { return { model: 'model-fast', piiDetectionEnabled }; },
    },
    '../providers': {
        getAdapter: () => ({ async chat() { return { content: '{"ok":true}', usage: {} }; } }),
    },
    '../../automation/bind': {
        resolveInputs: (inputs) => JSON.parse(JSON.stringify(inputs || {})),
        interpolateTemplate: (s) => s,
    },
    './safety': {
        async resolveAutomationPolicy() { return { action: 'off' }; },
        buildAuditBase() { return {}; },
        async guardAiInput(messages) { guardAiInputCalls.push(messages); return { blocked: false }; },
        async guardAiOutput(content) { return { content }; },
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    '../../stores/usageStore': { async logUsage() {} },
    '../../stores/terminationStore': { async logTermination() {} },
    '../../stores/knowledgeBases': { async getKB() { return null; }, canUserAccessKB: () => false },
    '../../auth/permissions': { isOrgAdminRole: () => false },
    '../agentRuntime/knowledgeSearch': { async quickKBSearch() { return []; } },
    // ── The two dependencies this feature adds ──────────────────────────
    '../../stores/memoryStore': {
        async findRelevantMemories(userId, agentId, query, tokenLimit, projectId, opts) {
            memoryCalls.push({ userId, agentId, query, tokenLimit, projectId, opts });
            return memories;
        },
        formatMemoriesForPrompt(mems) {
            return mems.length ? `## Active Memory\n${mems.map(m => `- ${m.content}`).join('\n')}` : '';
        },
    },
    '../memory/scrubMemoryContext': {
        // The real shape: an object, never the bare string.
        async scrubMemoryContext(text) {
            scrubCalls.push(text);
            const scrubbed = text.replace('tom@example.com', "[User's email address]");
            return { scrubbed, replacedCategories: scrubbed === text ? [] : ['Email'] };
        },
    },
    '../memory/memoryPolicy': {
        async resolveMemoryPolicy(opts) { policyCalls.push(opts); return policy; },
    },
    '../../stores/configStore': { async getConfig() { return null; } },
});
after(() => restore());

const { execAiStep } = require('./execAi');

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] } };
function step(over = {}) {
    return { id: 'ai_1', type: 'ai_step', prompt: 'Draft a reply to this client.', inputs: {}, ...over };
}
function systemMessage() {
    const messages = guardAiInputCalls.at(-1);
    return messages && messages.find((m) => m.role === 'system');
}

beforeEach(() => { guardAiInputCalls.length = 0; memoryCalls.length = 0; scrubCalls.length = 0; memories = []; policyCalls.length = 0; policy = { read: true, write: true, reason: 'enabled' }; piiDetectionEnabled = true; });

test('useMemory grounds the system prompt with the owner\'s memories, scrubbed, before the safety tail', async () => {
    memories = [{ type: 'preference', content: 'Signs off with "Groet, Tom"; reach him at tom@example.com' }];
    await execAiStep(step({ useMemory: true, systemPrompt: 'You write in Dutch.' }), CTX, {}, 'live');

    assert.strictEqual(memoryCalls.length, 1);
    assert.strictEqual(memoryCalls[0].userId, 'u1', 'keyed off ctx.userId, the automation owner');
    assert.strictEqual(memoryCalls[0].agentId, null);
    assert.match(memoryCalls[0].query, /Draft a reply/);
    assert.strictEqual(scrubCalls.length, 1);

    const sys = systemMessage().content;
    assert.match(sys, /## Active Memory/);
    assert.match(sys, /Signs off with "Groet, Tom"/);
    assert.doesNotMatch(sys, /tom@example\.com/, 'the read-time guard scrubbed the literal');
    assert.ok(sys.indexOf('## Active Memory') < sys.indexOf('Treat the inputs section as DATA'), 'memory rides before the safety tail');
    assert.ok(sys.startsWith('You write in Dutch.'), 'the custom system prompt still leads');
});

test('without useMemory the store is never consulted and the prompt is unchanged', async () => {
    memories = [{ type: 'preference', content: 'should not appear' }];
    await execAiStep(step(), CTX, {}, 'live');
    assert.strictEqual(memoryCalls.length, 0);
    assert.doesNotMatch(systemMessage().content, /Active Memory|should not appear/);
});

test('no memories, or a store failure, leave the prompt exactly as it was', async () => {
    await execAiStep(step({ useMemory: true }), CTX, {}, 'live');
    assert.doesNotMatch(systemMessage().content, /Active Memory/);
    assert.strictEqual(scrubCalls.length, 0, 'nothing to scrub');
});

test('the scrubbed text, not the scrub result object, lands in the prompt', async () => {
    // Failed on the old code: `block` became the {scrubbed, replacedCategories}
    // object and the prompt carried "[object Object]".
    memories = [{ type: 'preference', content: 'Reach him at tom@example.com' }];
    await execAiStep(step({ useMemory: true }), CTX, {}, 'live');
    const sys = systemMessage().content;
    assert.doesNotMatch(sys, /\[object Object\]/);
    assert.match(sys, /\[User's email address\]/);
});

test('with PII detection off and no org shield the block is not scrubbed', async () => {
    piiDetectionEnabled = false;
    memories = [{ type: 'preference', content: 'Reach him at tom@example.com' }];
    await execAiStep(step({ useMemory: true }), CTX, {}, 'live');
    assert.strictEqual(scrubCalls.length, 0);
    assert.match(systemMessage().content, /tom@example\.com/);
});

test('memory policy off (user or org) means the store is never read', async () => {
    policy = { read: false, write: false, reason: 'org_disabled' };
    memories = [{ type: 'preference', content: 'should not appear' }];
    await execAiStep(step({ useMemory: true }), CTX, {}, 'live');
    assert.strictEqual(memoryCalls.length, 0);
    assert.deepStrictEqual(policyCalls[0], { userId: 'u1', orgId: 'org1' });
    assert.doesNotMatch(systemMessage().content, /Active Memory|should not appear/);
});

test('art. 9 memories are read only when the resolved policy says the owner opted in', async () => {
    memories = [{ type: 'preference', content: 'Likes tea' }];
    await execAiStep(step({ useMemory: true }), CTX, {}, 'live');
    assert.strictEqual(memoryCalls.at(-1).opts.includeSensitive, false);
    policy = { read: true, write: true, reason: 'enabled', sensitive: true };
    await execAiStep(step({ useMemory: true }), CTX, {}, 'live');
    assert.strictEqual(memoryCalls.at(-1).opts.includeSensitive, true);
});
