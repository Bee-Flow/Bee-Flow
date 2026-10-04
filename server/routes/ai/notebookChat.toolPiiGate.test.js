/**
 * BFSF-354 — the notebook chat honours the Privacy Shield's tool block lists,
 * as direct chat and the agent loop do:
 *
 *   - a tool whose arguments carry a category on the "Outside tools" / "Own
 *     server" list is refused and never run. The check reads the values the
 *     call really carries: the notebook dispatches in token space and restores
 *     real values at its own write boundary (document edits, new sources), so
 *     those are checked on the real values; a web search keeps its tokens;
 *   - what the model reads of a tool result has those categories stripped;
 *   - the knowledge-base passages the turn injects without a tool call are
 *     stripped against the "Own server" list, as notebook_kb_search results are.
 *
 * It did none of it. A real server with the router mounted; dependencies are
 * stubbed through testUtils/stubRequire and the real gate runs with its
 * detector injected (the real orgShield classifies the tools). Synthetic data.
 *
 * Run: cd server && node --test routes/ai/notebookChat.toolPiiGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, SIGNED_IN, REFUSED_FOR_EMAIL, AI_AGENT_STUB, configStoreStub, gateFixture, resetFixture,
    injectEmailDetector, streamingToolCallProvider, serveRouter, postJson, kbChatGateTests,
} = require('../../testUtils/toolPiiGateHarness');

const pass = (req, res, next) => next();
const fx = gateFixture({ tokenMap: {}, kbSearches: [], webSearches: [], systemPrompts: [] });

const toolDef = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const restoreTokens = (text, map) => Object.entries(map || {}).reduce((s, [tok, real]) => s.split(tok).join(real), String(text));
const dlpRunnerStub = {
    getConversationTokenMap: () => fx.tokenMap,
    getConversationTokenMapAsync: async () => fx.tokenMap,
    mergeTokenMap: () => {},
};
const piiDetectionStub = { restoreTokens, restoreTokensInRichText: restoreTokens };

const restore = installResolveStub({
    '../../core/aiAgent': AI_AGENT_STUB,
    // Also what the real orgShield (loaded by the gate) reads.
    '../../stores/configStore': configStoreStub({ agent_search_url: 'http://search.invalid' }),
    '../../core/providers': streamingToolCallProvider(fx),
    '../../stores/notebookStore': {
        getNotebook: async () => ({ id: 'nb-1', name: 'Matter', knowledgeBaseIds: ['kb1'], documentMd: '' }),
        getSources: async () => [],
        touchActivity: async () => {},
    },
    '../../stores/notebookConversationStore': { appendMessages: async () => {} },
    '../../support/kbAccess': { partitionAccessibleKBIds: async (req, ids) => ({ allowed: ids, denied: [] }) },
    '../../core/entitlements/betaFeatures': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null },
    '../../auth': { resolveUserOrgIds: async () => new Set(['org-1']) },
    '../../auth/permissions': { requireAuth: pass },
    '../../core/llm/modelResolver': {
        getEUAwareTiers: async () => ({ fast: { modelId: 'model-1' } }),
        resolveEffectiveOrgId: async () => 'org-1',
        TIER_DEFAULTS: { fast: { maxTokens: 1024, temperature: 0.2 } },
    },
    '../../core/http/sseHelpers': { startSseHeartbeat: () => () => {} },
    '../../core/kb/notebookKnowledgeSearch': {
        searchNotebookKB: async () => ({
            chunks: [{ content: `billing: ${SYNTH_EMAIL}` }],
            citations: [{ title: 'Contacts', content: `billing: ${SYNTH_EMAIL}`, score: 0.9 }],
            contextPrompt: `### Source 1: Contacts\nbilling: ${SYNTH_EMAIL}`,
        }),
        executeNotebookKBSearchTool: async (args) => { fx.kbSearches.push(args); return { chunks: [{ content: `write to ${SYNTH_EMAIL}` }] }; },
        NOTEBOOK_KB_SEARCH_TOOL: toolDef('notebook_kb_search'),
        // The notebook has no sources here, so no title maps to one.
        findSourceForChunk: () => null,
    },
    '../../integrations/agentSearchTools': { AGENT_SEARCH_TOOLS: [toolDef('agent_search')], isAgentSearchTool: (n) => n === 'agent_search' },
    '../../integrations/agentSearchEgress': {
        runAgentSearchWithEgress: async (name, args) => { fx.webSearches.push(args); return { results: [`hit ${SYNTH_EMAIL}`] }; },
    },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield, mergeWithOrgShield: (org) => org },
    '../../core/agentRuntime/guardrailsRunner': { applyRegexGuardrails: () => ({ action: 'pass' }) },
    '../../core/privacy/guardrails': { checkRegexPatterns: () => [] },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    '../../core/dlp/dlpRunner': dlpRunnerStub,
    './dlpRunner': dlpRunnerStub,
    '../../core/privacy/piiDetection': piiDetectionStub,
    '../privacy/piiDetection': piiDetectionStub,
    '../../core/dlp/attachmentScanner': { scanAttachmentText: async ({ text }) => ({ action: 'pass', text }) },
    '../../core/dlp/composeScan': { composeScan: async ({ units }) => ({ units, stats: { segments: 0 } }) },
    '../../agents/notebooks/sourceIngestion': { ingestTextSource: async () => {} },
});

injectEmailDetector(require('../../core/privacy/toolPiiGate'));

const baseUrl = serveRouter(test, require('./notebookChat'), { prefix: '/ai', session: SIGNED_IN, restore });

const NOTEBOOK_SHIELD = { ...OWN_SERVER_EMAIL, rulesWithNames: [], scope: {} };

async function turn({ shield = NOTEBOOK_SHIELD, toolCall, tokenMap = {} }) {
    resetFixture(fx, { shield, toolCall, tokenMap });
    const res = await postJson(`${baseUrl()}/chat/notebook/stream`, { message: 'who handles billing?', notebookId: 'nb-1' });
    assert.strictEqual(res.status, 200, res.body);
    return res.body;
}

// Refused and stripped as in the webpage builder's chat.
kbChatGateTests(test, { fx, turn, kbTool: 'notebook_kb_search', source: 'notebook' });

// The notebook restores real values at its own write boundary, so those are
// what the gate checks.
test('a document edit is checked on the real value its token stands for', async () => {
    await turn({
        toolCall: { name: 'notebook_doc_replace', args: { find_text: 'contact', replace_text: 'contact [email_1]' } },
        tokenMap: { '[email_1]': SYNTH_EMAIL },
    });
    assert.match(fx.toolMessages[0].content, REFUSED_FOR_EMAIL);
});
