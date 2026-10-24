// @typecheck
/**
 * Test kit: the notebookChat router with its dependencies stubbed.
 *
 * Shared by notebookChat.toolPiiGate.test.js and notebookChat.kbScanning.test.js.
 * Keys are the require strings exactly as notebookChat (and the modules it
 * loads) write them: a non-matching key silently loads the real module, see
 * server/ARCHITECTURE.md. `notebookChatStubs(fx, over)` returns the map for
 * `installResolveStub`; for a key that has a default, the object in `over` is
 * merged over it (shallow), a key without one is added.
 *
 * The route's steps live one directory down (./notebookChat/), where the same
 * module is required as '../../../x' instead of '../../x'. `withStepAliases`
 * registers every '../../x' stub under that spelling too, so one map covers
 * the route and its steps; notebookChatStubs applies it itself.
 */

/** Every '../../x' key of a stub map also under '../../../x' (the steps' spelling). */
function withStepAliases(map) {
    const out = { ...map };
    for (const [key, value] of Object.entries(map)) {
        if (key.startsWith('../../') && !key.startsWith('../../../')) {
            const alias = `../${key}`;
            if (!(alias in out)) out[alias] = value;
        }
    }
    return out;
}

const { AI_AGENT_STUB, configStoreStub } = require('../../testUtils/toolPiiGateHarness');
const { quietSse } = require('../../testUtils/quietSse');

const pass = (req, res, next) => next();

const toolDef = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });

function notebookChatStubs(fx, over = {}) {
    const dlpRunnerStub = {
        getConversationTokenMap: () => fx.tokenMap,
        getConversationTokenMapAsync: async () => fx.tokenMap,
        mergeTokenMap: () => {},
    };
    const piiDetectionStub = { restoreTokens: (t) => String(t), restoreTokensInRichText: (t) => String(t) };
    const map = {
        '../../core/aiAgent': AI_AGENT_STUB,
        // Also what the real orgShield (loaded by the gate) reads.
        '../../stores/configStore': configStoreStub({ agent_search_url: 'http://search.invalid' }),
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
        '../../core/http/sseHelpers': quietSse(),
        // The notebook has no sources here, so no title maps to one.
        '../../core/kb/notebookKnowledgeSearch': {
            NOTEBOOK_KB_SEARCH_TOOL: toolDef('notebook_kb_search'),
            findSourceForChunk: () => null,
        },
        '../../integrations/agentSearchTools': { AGENT_SEARCH_TOOLS: [toolDef('agent_search')], isAgentSearchTool: (n) => n === 'agent_search' },
        '../../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield, mergeWithOrgShield: (org) => org },
        '../../core/agentRuntime/guardrailsRunner': { applyRegexGuardrails: () => ({ action: 'pass' }) },
        '../../core/privacy/guardrails': { checkRegexPatterns: () => [] },
        '../../stores/guardrailEventStore': { logGuardrailEvent: async () => {} },
        '../../core/dlp/dlpRunner': dlpRunnerStub,
        './dlpRunner': dlpRunnerStub,
        '../../core/privacy/piiDetection': piiDetectionStub,
        '../privacy/piiDetection': piiDetectionStub,
        '../../core/dlp/attachmentScanner': { scanAttachmentText: async ({ text }) => ({ action: 'pass', text }) },
        '../../core/dlp/composeScan': { composeScan: async ({ units }) => ({ units, stats: { segments: 0 } }) },
        '../../agents/notebooks/sourceIngestion': { ingestTextSource: async () => {} },
    };
    for (const [key, value] of Object.entries(over)) {
        map[key] = key in map && value && typeof value === 'object' && !Array.isArray(value) ? { ...map[key], ...value } : value;
    }
    return withStepAliases(map);
}

module.exports = { notebookChatStubs, withStepAliases, toolDef, pass };
