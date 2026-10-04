/**
 * execAiStep's Knowledge Base grounding (BFSF-410).
 *
 * Mirrors server/appStudio/actionExecutor.ai.test.js's KB-grounding coverage,
 * but for the automation runner rather than App Studio: a single upfront
 * search per step run, injected into the system prompt as "Reference
 * material:" — never an agentic kb_search/kb_fetch tool loop.
 *
 * The property worth protecting here is the permission re-check: quickKBSearch
 * performs NO tenant filtering of its own (core/kb/localKBIngest.js — "access
 * is already gated by kb_ids upstream"), so an ai_step naming a foreign KB id
 * must never reach it. That check has to run BEFORE the search, keyed off
 * ctx.userId/ctx.orgId — never an app-level owner, because an automation has
 * none.
 *
 * Run: node --test --test-force-exit core/automationRunner/execAi.kb.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── The doubles ────────────────────────────────────────────────────────────

const chatCalls = [];
let chatReply = '{"ok":true}';

const TIERS = { fast: { modelId: 'model-fast', maxTokens: 4096 } };

// One KB the running user owns, one that belongs to somebody else entirely —
// the exact shape KnowledgeBasesStore rows carry.
const KB_ROWS = {
    kb_ok: { id: 'kb_ok', tenant_id: 'u1', organization_id: 'org1', is_published: true, shared_groups: '[]' },
    kb_foreign: { id: 'kb_foreign', tenant_id: 'someone-else', organization_id: 'org-foreign', is_published: true, shared_groups: '[]' },
};
const kbGetCalls = [];

// A faithful-enough stand-in for the real store's policy predicate — owner or
// same published org, nothing else — so the test exercises the same shape of
// decision execAi.js actually consults.
const accessOpts = [];
function canUserAccessKB(kb, userId, orgIds, groups, opts) {
    accessOpts.push(opts || {});
    if (!kb) return false;
    if (kb.tenant_id === userId) return true;
    if (orgIds instanceof Set && kb.organization_id && orgIds.has(kb.organization_id) && kb.is_published) return true;
    return false;
}

const guardAiInputCalls = [];
const quickKBSearchCalls = [];
let quickKBSearchResult = [];

const restore = installResolveStub({
    '../llm/modelResolver': { async getUserTierMap() { return TIERS; } },
    '../entitlements/userTiers': { async getPermittedTierKeys() { return null; } },
    '../llm/promptClassifier': { async classifyWithLLM() { return { tier: 'fast' }; } },
    '../aiAgent': {
        async getProviderForModel(modelId) { return { apiKey: 'k', url: 'u', providerType: 'test', modelId }; },
        async getAIConfig() { return { model: 'model-fast' }; },
    },
    '../providers': {
        getAdapter: () => ({
            async chat(_key, _url, modelId, messages, options) {
                chatCalls.push({ modelId, options });
                return { content: chatReply, usage: {} };
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
        async guardAiInput(messages) { guardAiInputCalls.push(messages); return { blocked: false }; },
        async guardAiOutput(content) { return { content }; },
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    '../../stores/usageStore': { async logUsage() {} },
    '../../stores/terminationStore': { async logTermination() {} },
    // ── The two dependencies this feature adds ──────────────────────────
    '../../stores/knowledgeBases': {
        async getKB(id) { kbGetCalls.push(id); return KB_ROWS[id] || null; },
        canUserAccessKB,
    },
    '../../auth/permissions': {
        isOrgAdminRole: (role) => role === 'org_admin' || role === 'admin',
    },
    '../agentRuntime/knowledgeSearch': {
        async quickKBSearch(userId, kbIds, query, opts) {
            quickKBSearchCalls.push({ userId, kbIds, query, opts });
            return quickKBSearchResult;
        },
    },
});
after(() => restore());

const { execAiStep } = require('./execAi');

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] } };

function step(over = {}) {
    return { id: 'ai_1', type: 'ai_step', prompt: 'Draft a reply in our brand voice.', inputs: {}, ...over };
}

beforeEach(() => {
    chatCalls.length = 0;
    chatReply = '{"ok":true}';
    kbGetCalls.length = 0;
    accessOpts.length = 0;
    guardAiInputCalls.length = 0;
    quickKBSearchCalls.length = 0;
    quickKBSearchResult = [];
});

function systemMessage() {
    const messages = guardAiInputCalls.at(-1);
    return messages && messages.find((m) => m.role === 'system');
}

// ── 1. Grounding is injected when knowledgeBaseIds is set ──────────────────

test('grounding is injected as "Reference material:" in the system prompt', async () => {
    quickKBSearchResult = [{ title: 'Brand style guide', content: 'Always use formal Dutch.', score: 0.9 }];
    await execAiStep(step({ knowledgeBaseIds: ['kb_ok'] }), CTX, {}, 'live');

    assert.strictEqual(quickKBSearchCalls.length, 1);
    assert.deepStrictEqual(quickKBSearchCalls[0].kbIds, ['kb_ok']);
    assert.strictEqual(quickKBSearchCalls[0].userId, 'u1', 'keyed off ctx.userId, not an app owner');

    const sys = systemMessage();
    assert.ok(sys, 'a system message must have been sent');
    assert.match(sys.content, /Reference material:/);
    assert.match(sys.content, /Always use formal Dutch\./);
});

test('no knowledgeBaseIds means no grounding and no KB lookups at all', async () => {
    await execAiStep(step(), CTX, {}, 'live');
    assert.strictEqual(quickKBSearchCalls.length, 0);
    assert.strictEqual(kbGetCalls.length, 0);
    assert.doesNotMatch(systemMessage().content, /Reference material:/);
});

// ── 2. An unauthorized/foreign KB id is rejected, not silently searched ────

test('a foreign knowledgeBaseId is excluded — never reaches quickKBSearch', async () => {
    await execAiStep(step({ knowledgeBaseIds: ['kb_foreign'] }), CTX, {}, 'live');

    assert.strictEqual(kbGetCalls.length, 1, 'the id is still looked up to be checked');
    assert.strictEqual(quickKBSearchCalls.length, 0, 'but never searched — access was denied');
    assert.doesNotMatch(systemMessage().content, /Reference material:/);
});

test('an unknown (deleted / made-up) KB id is dropped, not thrown', async () => {
    await assert.doesNotReject(() => execAiStep(step({ knowledgeBaseIds: ['kb_does_not_exist'] }), CTX, {}, 'live'));
    assert.strictEqual(quickKBSearchCalls.length, 0);
});

test('mixed ids: only the accessible one reaches the search', async () => {
    quickKBSearchResult = [{ title: 'Brand style guide', content: 'x', score: 0.9 }];
    await execAiStep(step({ knowledgeBaseIds: ['kb_foreign', 'kb_ok'] }), CTX, {}, 'live');

    assert.strictEqual(quickKBSearchCalls.length, 1);
    assert.deepStrictEqual(quickKBSearchCalls[0].kbIds, ['kb_ok']);
});

// ── 3. guardAiInput sees the augmented prompt ───────────────────────────────

test('the KB content reaches guardAiInput as part of the system message, not a side channel', async () => {
    quickKBSearchResult = [{ title: 'Handbook', content: 'the secret sauce', score: 0.9 }];
    await execAiStep(step({ knowledgeBaseIds: ['kb_ok'] }), CTX, {}, 'live');

    // guardAiInput is called exactly once per execAiStep, with the full
    // messages array — the KB block must already be inside it (BFSF-410
    // requires the augmented prompt to be scanned like everything else).
    assert.strictEqual(guardAiInputCalls.length, 1);
    assert.match(systemMessage().content, /the secret sauce/);
});

// ── 4. Dry-run never performs a live search ─────────────────────────────────

test('dry-run skips the KB search entirely — no permission lookups, no live call', async () => {
    await execAiStep(step({ knowledgeBaseIds: ['kb_ok'] }), CTX, {}, 'dry_run');

    assert.strictEqual(kbGetCalls.length, 0, 'dry-run must not even consult the KB store');
    assert.strictEqual(quickKBSearchCalls.length, 0);
    assert.doesNotMatch(systemMessage().content, /Reference material:/);
});

// ── 5. The org-admin bypass does not follow an automation into a retrieval ─────

test('an automation owned by an org admin still only grounds on what its owner may read', async () => {
    // canUserAccessKB lets an org admin READ any base in their org, which is
    // right for a management screen. Passed through here it meant an automation
    // owned by an admin ground itself on a colleague's unfinished draft, and
    // the run log said the automation had read it.
    await execAiStep(
        step({ knowledgeBaseIds: ['kb_ok'] }),
        { ...CTX, orgRole: 'org_admin' },
        {}, 'live',
    );
    assert.strictEqual(accessOpts.length, 1);
    assert.strictEqual(accessOpts[0].isOrgAdmin, false, 'never the admin bypass at retrieval');
});
