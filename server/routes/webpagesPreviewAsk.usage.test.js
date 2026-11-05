// @typecheck
/**
 * The ledger row of the webpage AI bridge's agentic ask (POST /:id/ai/ask):
 * the page's author pays (`user_id`, `organization_id`), the signed-in viewer
 * who asked is the actor (`actor_user_id`), and the webpage stays the object
 * (`agent_id`). Same harness as webpagesPreview.toolPiiGate.test.js.
 *
 * Run: cd server && node --test routes/webpagesPreviewAsk.usage.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const { quietSse } = require('../testUtils/quietSse');
const assert = require('node:assert');
const express = require('express');
const { installResolveStub } = require('../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, injectEmailDetector, streamingToolCallProvider, serveRouter, postJson,
} = require('../testUtils/toolPiiGateHarness');
const { areaOf } = require('../shared/usageAreas');

const pass = (req, res, next) => next();
const fx = {
    shield: null, shieldCalls: [], toolCall: null, kbResult: null,
    dispatched: [], searched: [], guardrailRows: [], toolMessages: [], usageRows: [],
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
    '../stores/usageStore': { logUsage: async (row) => { fx.usageRows.push(row); } },
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
    '../core/http/sseHelpers': quietSse(),
    '../core/privacy/orgShield': {
        resolveShieldFor: async (who) => { fx.shieldCalls.push(who); return fx.shield; },
    },
    '../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
});

injectEmailDetector(require('../core/privacy/toolPiiGate'));

const baseUrl = serveRouter(test, require('./webpagesPreview'), { prefix: '/preview', restore });

async function ask({ shield = OWN_SERVER_EMAIL, toolCall }) {
    Object.assign(fx, {
        shield, shieldCalls: [], toolCall, dispatched: [], searched: [], guardrailRows: [], toolMessages: [], usageRows: [],
        kbResult: { chunks: [{ content: `billing: ${SYNTH_EMAIL}` }], contextPrompt: `billing: ${SYNTH_EMAIL}` },
    });
    return postJson(`${baseUrl()}/wp-1/ai/ask`, { prompt: 'who do I write to?' });
}

test('the ask is logged under the author with the viewer as actor', async () => {
    const res = await ask({ shield: null, toolCall: { name: 'page_knowledge_search', args: { query: 'billing' } } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(fx.usageRows.length, 1);
    const row = fx.usageRows[0];
    assert.strictEqual(row.user_id, 'author-1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.actor_user_id, 'viewer-1');
    assert.strictEqual(row.agent_id, 'wp-1');
    assert.strictEqual(row.source, 'webpage_bridge_ai_agentic');
    assert.notStrictEqual(areaOf(row.source), 'other');
});
