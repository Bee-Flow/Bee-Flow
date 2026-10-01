/**
 * chatWithAgent (the non-streaming agent loop: support responder and the
 * non-streaming agent route) bills what the provider really reported.
 *
 * It read `usage.prompt_tokens` / `completion_tokens` and
 * `usage.cache_creation_input_tokens`, while the non-streaming Claude and
 * Gemini adapters returned the raw provider block: a call on either logged
 * zero tokens at zero cost. The adapter here is the REAL one (only the SDK
 * client is stubbed).
 *
 * Run: node --test core/agentRuntime/chatWithAgent.usage.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const {
    realClaudeAdapter, realGeminiAdapter, assertClaudeEntry, assertGeminiEntry,
} = require('../providers/usageHarness');

let adapter = null;
const logged = [];

const restore = installResolveStub({
    '../aiAgent': {
        getAIConfig: async () => ({}),
        getProviderForModel: async () => ({ apiKey: 'test-key', url: 'http://llm.invalid', providerType: 'claude', providerName: 'test' }),
    },
    '../providers': { getAdapter: () => adapter },
    '../../stores/agentStore': {
        getForRuntime: async (id) => ({ id, name: 'Test agent', organization_id: 'org-1', owner_id: 'owner-1', config: {} }),
        getAgentToolsWithParams: async () => [],
        getOrCreateConversation: async () => ({ id: 'conv-1', messages: [] }),
        updateConversation: async () => {},
    },
    '../../stores/usageStore': { logUsage: async (entry) => { logged.push(entry); } },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async () => {} },
    '../../utils/sanitize': { sanitizeToolResult: (r) => r },
    '../../utils/messageUtils': { sanitizeMessages: (m) => m },
    '../../utils/unicodeSanitizer': { sanitizeMessagesUnicode: () => ({ smugglingDetected: false }) },
    '../tools/toolExecution': {},
    '../tools/toolDispatcher': { executeTool: async () => ({ ok: true }) },
    '../integrations/connectionResolution': { isLendingEnabled: () => false },
    './modelResolver': { resolveAgentModelWithTier: async () => ({ modelId: 'test-model', tierKey: 'fast' }) },
    '../llm/modelResolver': { getEUAwareTiers: async () => ({}), TIER_DEFAULTS: {}, findTierKeyForModel: () => null },
    './agentTools': { getAgentTools: async () => [] },
    './toolPolicy': { mayLendOwnerConnection: () => false },
    '../llm/promptUtils': { processSystemPrompt: (s) => s },
    '../privacy/piiDetection': { validateInputForPii: async () => null },
    '../privacy/orgShield': { resolveShieldFor: async () => null },
    '../dlp/dlpRunner': { getConversationTokenMap: () => ({}), mergeTokenMap: () => {} },
    '../dlp/tokenPreservationPrompt': { buildTokenPreservationAddendum: () => '' },
    '../dlp/applyTokenMapToOutbound': { applyTokenMapToOutbound: ({ systemPrompt, messages }) => ({ systemPrompt, messages }) },
    '../../telemetry/metrics': { recordAgentRun: () => {} },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
});
test.after(() => restore());

const { chatWithAgent } = require('./chatWithAgent');

test('a Claude agent turn logs real tokens, cache read/write and the 5m/1h split', async () => {
    logged.length = 0;
    adapter = realClaudeAdapter([{ text: 'Hello.' }]);
    const out = await chatWithAgent('agent-1', 'user-1', 'hi');
    assert.strictEqual(out.message, 'Hello.');
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].source, 'agent_chat');
    assertClaudeEntry(logged[0]);
});

test('a Gemini agent turn logs real tokens, thoughts and cache', async () => {
    logged.length = 0;
    adapter = realGeminiAdapter([{ text: 'Hello.' }]);
    await chatWithAgent('agent-1', 'user-1', 'hi');
    assert.strictEqual(logged.length, 1);
    assertGeminiEntry(logged[0]);
});
