/**
 * BFSF-354 — the webpage AI bridge's agentic ask (POST /:id/ai/ask) honours
 * the page author's Privacy Shield tool block lists. The bridge acts as the
 * author, with the author's knowledge bases and integrations, and it refused
 * nothing: a tool whose arguments carried an "Own server" / "Outside tools"
 * category ran, and what came back reached the model unstripped.
 *
 * A real server with the router mounted; its dependencies are stubbed through
 * testUtils/stubRequire and the real gate runs with its detector injected
 * (the real orgShield classifies the tools). Test data is synthetic.
 *
 * Run: cd server && node --test routes/webpagesPreview.toolPiiGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { installResolveStub } = require('../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, REFUSED_FOR_EMAIL, injectEmailDetector, streamingToolCallProvider,
    serveRouter, postJson, assertStripped, assertRefusalAudited,
} = require('../testUtils/toolPiiGateHarness');

const pass = (req, res, next) => next();
const fx = {
    shield: null, shieldCalls: [], toolCall: null, kbResult: null,
    dispatched: [], searched: [], guardrailRows: [], toolMessages: [],
};

const CTX = {
    webpage: { name: 'Support page', knowledgeBaseIds: ['kb1'] },
    authorUserId: 'author-1',
    authorOrgId: 'org-1',
    authorSession: null,
    bridgeGrants: {
        ai: { enabled: true, groundOnPage: true },
        integrations: [{ tool: 'gmail_search' }],
        automations: [],
    },
};

const restore = installResolveStub({
    // The real orgShield (loaded by the gate for the tool classification)
    // reads its config here.
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
    './webpagesPreviewRateLimits': {
        llmBridgeLimiter: pass, sideEffectBridgeLimiter: pass, integrationBridgeLimiter: pass, dbBridgeLimiter: pass,
    },
    './webpagesPreviewTables': express.Router(),
    '../stores/webpageDbStore': {},
    '../stores/webpageStore': {},
    '../stores/automationStore': {},
    '../stores/usageStore': { logUsage: async () => {} },
    '../auth/webpagePreviewToken': {
        requirePreviewToken: (req, res, next) => { req.previewClaims = { viewerUserId: 'viewer-1', webpageId: 'wp-1' }; next(); },
    },
    '../core/webpages/webpageBridgeAuth': { loadAuthorContext: async () => CTX },
    '../core/llm/llmClient': {},
    '../core/llm/modelResolver': { resolveModelForTier: async () => 'model-1', TIER_DEFAULTS: { fast: { maxTokens: 1024, temperature: 0.2 } } },
    '../core/webpages/webpageKnowledgeSearch': {
        searchWebpageKB: async ({ query }) => { fx.searched.push(query); return fx.kbResult; },
    },
    '../core/webpages/webpageAiMessages': { buildAiMessages: async () => [{ role: 'user', content: 'who do I write to?' }] },
    '../core/tools/toolDispatcher': {
        executeTool: async (name, args) => { fx.dispatched.push({ name, args }); return { hits: [`reply to ${SYNTH_EMAIL}`] }; },
    },
    '../automation/toolRegistry': {
        findOwnerOfTool: (tool) => (tool === 'gmail_search' ? { app: 'gmail' } : null),
        loadTools: () => [{ type: 'function', function: { name: 'gmail_search', parameters: { type: 'object', properties: {} } } }],
    },
    '../integrations/webpageFramework': { resolveRuntime: () => 'static' },
    '../integrations/webpageApiRuntime': { executeApiHandler: async () => ({}) },
    '../core/aiAgent': { getProviderForModel: async () => ({ providerType: 'openai', url: 'http://model.invalid', apiKey: 'k' }) },
    '../core/providers': streamingToolCallProvider(fx),
    '../core/http/sseHelpers': { startSseHeartbeat: () => () => {} },
    '../core/privacy/orgShield': {
        resolveShieldFor: async (who) => { fx.shieldCalls.push(who); return fx.shield; },
    },
    '../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
});

injectEmailDetector(require('../core/privacy/toolPiiGate'));

const baseUrl = serveRouter(test, require('./webpagesPreview'), { prefix: '/preview', restore });

async function ask({ shield = OWN_SERVER_EMAIL, toolCall }) {
    Object.assign(fx, {
        shield, shieldCalls: [], toolCall, dispatched: [], searched: [], guardrailRows: [], toolMessages: [],
        kbResult: { chunks: [{ content: `billing: ${SYNTH_EMAIL}` }], contextPrompt: `billing: ${SYNTH_EMAIL}` },
    });
    return postJson(`${baseUrl()}/wp-1/ai/ask`, { prompt: 'who do I write to?' });
}

test('a knowledge search whose query carries an own-server category is refused, never run', async () => {
    const res = await ask({ toolCall: { name: 'page_knowledge_search', args: { query: `mail from ${SYNTH_EMAIL}` } } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(fx.searched, [], 'a refused tool must not run');
    assert.match(fx.toolMessages[0].content, REFUSED_FOR_EMAIL);
    assertRefusalAudited(fx.guardrailRows, 'webpage_ai');
    assert.deepStrictEqual(fx.shieldCalls, [{ orgId: 'org-1', userId: 'author-1' }], 'the author\'s shield');
});

test('a passage with an own-server category is stripped before the model reads it', async () => {
    await ask({ toolCall: { name: 'page_knowledge_search', args: { query: 'billing' } } });
    assert.deepStrictEqual(fx.searched, ['billing']);
    assertStripped(fx.toolMessages[0].content);
    assert.ok(fx.guardrailRows.some(r => r.action_taken === 'tool_result_redacted'));
});

test('an outside tool is held to the outside list, not the own-server one', async () => {
    await ask({ toolCall: { name: 'gmail_search', args: { query: SYNTH_EMAIL } } });
    assert.strictEqual(fx.dispatched.length, 1, 'the own-server list does not reach an outside tool');
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));

    const outside = { ...OWN_SERVER_EMAIL, toolPiiPolicy: { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } } };
    await ask({ shield: outside, toolCall: { name: 'gmail_search', args: { query: SYNTH_EMAIL } } });
    assert.strictEqual(fx.dispatched.length, 0);
    assert.match(fx.toolMessages[0].content, /forbids sending to external tools/);
});

test('no shield changes nothing', async () => {
    await ask({ shield: null, toolCall: { name: 'page_knowledge_search', args: { query: SYNTH_EMAIL } } });
    assert.deepStrictEqual(fx.searched, [SYNTH_EMAIL]);
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));
});
