/**
 * BFSF-354 — the webpage builder's chat honours the Privacy Shield's tool
 * block lists, as direct chat and the agent loop do:
 *
 *   - a tool whose arguments carry a category on the "Outside tools" / "Own
 *     server" list is refused and never dispatched;
 *   - what the model reads of a tool result has those categories stripped;
 *   - the knowledge-base passages the turn injects into the prompt without a
 *     tool call are stripped against the "Own server" list, as the same
 *     passages fetched through webpage_kb_search are.
 *
 * It did none of it. A real server with the router mounted; dependencies are
 * stubbed through testUtils/stubRequire and the real gate runs with its
 * detector injected (the real orgShield classifies the tools). Synthetic data.
 *
 * Run: cd server && node --test routes/ai/webpageChat.toolPiiGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, SIGNED_IN, AI_AGENT_STUB, configStoreStub, gateFixture, resetFixture,
    injectEmailDetector, streamingToolCallProvider, serveRouter, postJson, kbChatGateTests,
} = require('../../testUtils/toolPiiGateHarness');

const pass = (req, res, next) => next();
const fx = gateFixture({ kbSearches: [], webSearches: [], systemPrompts: [] });

const WEBPAGE = { id: 'wp-1', name: 'Landing', knowledgeBaseIds: ['kb1'] };
const webpageStoreStub = { getWebpage: async () => WEBPAGE, getSources: async () => [] };
const dlpRunnerStub = { getConversationTokenMap: () => ({}), mergeTokenMap: () => {} };
const toolDef = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });

const restore = installResolveStub({
    '../../core/aiAgent': AI_AGENT_STUB,
    // Also what the real orgShield (loaded by the gate) reads.
    '../../stores/configStore': configStoreStub({ agent_search_url: 'http://search.invalid' }),
    '../../core/providers': streamingToolCallProvider(fx),
    '../../stores/webpageStore': webpageStoreStub,
    '../stores/webpageStore': webpageStoreStub,
    '../../core/http/sseHelpers': { startSseHeartbeat: () => () => {} },
    '../../core/webpages/versionFacts': {},
    '../../core/webpages/webpageUsageSync': { reconcileWebpageUsageDetached: () => {} },
    '../../integrations/webpageMultiFileTools': { WEBPAGE_MULTI_FILE_TOOLS: [], executeMultiFileTool: async () => ({}), isMultiFileTool: () => false },
    '../../integrations/webpageDbTools': { WEBPAGE_DB_TOOLS: [], executeDbTool: async () => ({}), isDbTool: () => false },
    '../../integrations/agentSearchTools': { AGENT_SEARCH_TOOLS: [toolDef('agent_search')], isAgentSearchTool: (n) => n === 'agent_search' },
    '../../integrations/agentSearchEgress': {
        runAgentSearchWithEgress: async (name, args) => { fx.webSearches.push(args); return { results: [`hit ${SYNTH_EMAIL}`] }; },
    },
    '../../integrations/webpageScreenshotTools': {
        WEBPAGE_SCREENSHOT_TOOL: toolDef('webpage_screenshot'), executeScreenshotTool: async () => ({}), isScreenshotTool: () => false,
    },
    '../../integrations/webpageBridgeTools': { WEBPAGE_BRIDGE_TOOLS: [], executeBridgeTool: async () => ({}), isBridgeTool: () => false },
    '../../core/webpages/webpageKnowledgeSearch': {
        searchWebpageKB: async () => ({
            chunks: [{ content: `billing: ${SYNTH_EMAIL}` }],
            citations: [{ title: 'Contacts', content: `billing: ${SYNTH_EMAIL}`, score: 0.9 }],
            contextPrompt: `### Source 1: Contacts\nbilling: ${SYNTH_EMAIL}`,
        }),
        executeWebpageKBSearchTool: async (args) => { fx.kbSearches.push(args); return { chunks: [{ content: `write to ${SYNTH_EMAIL}` }] }; },
        WEBPAGE_KB_SEARCH_TOOL: toolDef('webpage_kb_search'),
    },
    '../../stores/terminationStore': { logTermination: async () => {} },
    '../../auth/permissions': { requireAuth: pass },
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null },
    '../../auth': { resolveUserOrgIds: async () => new Set(['org-1']) },
    '../../core/llm/modelResolver': {
        getEUAwareTiers: async () => ({ fast: { modelId: 'model-1' } }),
        resolveEffectiveOrgId: async () => 'org-1',
        TIER_DEFAULTS: { fast: { maxTokens: 1024, temperature: 0.2 } },
    },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield },
    '../../core/dlp/attachmentScanner': { scanAttachmentText: async ({ text }) => ({ action: 'pass', text }) },
    '../../core/dlp/dlpRunner': dlpRunnerStub,
    './dlpRunner': dlpRunnerStub,
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
});

injectEmailDetector(require('../../core/privacy/toolPiiGate'));

const baseUrl = serveRouter(test, require('./webpageChat'), { prefix: '/ai', session: SIGNED_IN, restore });

async function turn({ shield = OWN_SERVER_EMAIL, toolCall }) {
    resetFixture(fx, { shield, toolCall });
    const res = await postJson(`${baseUrl()}/chat/webpage/stream`, { message: 'who handles billing?', webpageId: 'wp-1', chatMode: 'auto' });
    assert.strictEqual(res.status, 200, res.body);
    return res.body;
}

kbChatGateTests(test, { fx, turn, kbTool: 'webpage_kb_search', source: 'webpage_chat' });
