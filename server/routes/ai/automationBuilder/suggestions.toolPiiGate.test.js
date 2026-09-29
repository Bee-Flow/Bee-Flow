/**
 * BFSF-354 — the "Find repeating work" scan lets a model read the user's
 * connected apps, one tool call at a time. Those reads now honour the Privacy
 * Shield's tool block lists as chat does: a read whose arguments carry a
 * category on the "Outside tools" / "Own server" list is refused, and what the
 * model reads back has those categories stripped. The shield is the routine
 * policy's (the scan already guards its reads through that pipeline), so an
 * org that keeps routines out of the shield keeps the scan out as well.
 *
 * The route's collaborators are stubbed through testUtils/stubRequire; the
 * model's tool loop is a stand-in that makes one call through the scan's own
 * executor. The real gate runs with its detector injected and the real
 * orgShield classifies the tools. Synthetic data.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/suggestions.toolPiiGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, SIGNED_IN, REFUSED_FOR_EMAIL, configStoreStub, resetFixture,
    injectEmailDetector, serveRouter, postJson, assertStripped, assertRefusalAudited,
} = require('../../../testUtils/toolPiiGateHarness');

const pass = (req, res, next) => next();
const fx = { shield: null, toolCall: null, readResult: null, reads: [], toolOut: null, guardrailRows: [] };

const restore = installResolveStub({
    '../../../stores/automationStore': { getAutomationsForUser: async () => [] },
    '../../../core/llm/modelResolver': {
        isEUModeActive: async () => ({ isEU: false }),
        resolveModelForTierName: async () => 'fast-model',
    },
    '../../../core/llm/llmClient': {
        // One round: the model reads fx.toolCall through the scan's executor.
        runToolLoop: async (_model, _messages, _tools, _opts, executeTool) => {
            fx.toolOut = await executeTool(fx.toolCall.name, fx.toolCall.args);
            return { toolCallRounds: 1, structured: null, content: '[]' };
        },
        chatForcedTool: async () => ({ structured: null, content: '' }),
    },
    '../../../auth/permissions': { requireAuth: pass },
    './rateLimits': { suggestRateLimit: pass, feedbackRateLimit: pass },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => true },
    '../../../core/http/sseHelpers': {
        setupSSE: () => ({ sendEvent: () => {}, abortController: new AbortController(), markEnded() {} }),
        startSseHeartbeat: () => () => {},
    },
    '../../../automation/suggestions': {
        buildScanSystemPrompt: () => 'sys',
        buildScanDigest: () => '',
        parseSuggestionsJson: () => [],
        extractSuggestionsFromToolCall: () => [],
        normaliseSuggestions: () => [],
        buildActivityIndex: () => null,
        computeScanCacheKey: () => 'k',
        resolveActivityFilter: () => ({}),
        SUGGESTIONS_TOOL: {},
    },
    '../../../stores/suggestionScanCache': {
        deriveScopeKey: () => 'scope',
        getCachedScan: async () => null,
        upsertScan: async () => {},
    },
    '../../../stores/suggestionFeedbackStore': { VALID_ACTIONS: ['dismissed', 'built', 'asked'], getRecentSuppressedTitles: async () => [] },
    '../../../stores/integrationActivityStore': { getIntegrationByTool: async () => [] },
    '../../../core/integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [{ type: 'function', function: { name: fx.toolCall.name } }] }),
    },
    '../../../automation/sideEffectMap': { isSideEffect: () => false },
    '../../../core/integrations/integrationToolMap': { resolveIntegration: (name) => ({ integration: name.split('_')[0] }) },
    '../../../core/tools/toolDispatcher': {
        executeTool: async (name, args) => { fx.reads.push({ name, args }); return fx.readResult; },
    },
    '../../../core/http/captureCall': {
        captureCall: async (fn) => { try { return { ok: true, value: await fn(), probe: null }; } catch (e) { return { ok: false, error: e }; } },
    },
    '../../../core/automationRunner/safety': {
        resolveAutomationPolicy: async () => ({ shield: fx.shield }),
        buildAuditBase: () => ({ source: 'routine', agent_name: 'Suggestion scan' }),
        guardToolOutput: async (out) => ({ result: out, categories: [] }),
        logEgress: async () => {},
    },
    '../../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    // The real orgShield (loaded by the gate for the tool classification)
    // reads its config here.
    '../../stores/configStore': configStoreStub(),
});

injectEmailDetector(require('../../../core/privacy/toolPiiGate'));

const baseUrl = serveRouter(test, require('./suggestions'), { prefix: '/builder', session: SIGNED_IN, restore });

async function run({ shield = OWN_SERVER_EMAIL, toolCall, readResult = { ok: true } }) {
    resetFixture(fx, { shield, toolCall, readResult, toolOut: null });
    const res = await postJson(`${baseUrl()}/suggest`, { integrationIds: [], force: true });
    assert.strictEqual(res.status, 200, res.body);
}

test('a read whose arguments carry an own-server category is refused, never made', async () => {
    await run({ toolCall: { name: 'kb_search', args: { query: `mail from ${SYNTH_EMAIL}` } } });
    assert.deepStrictEqual(fx.reads, [], 'a refused read must not run');
    assert.match(fx.toolOut, REFUSED_FOR_EMAIL);
    assertRefusalAudited(fx.guardrailRows, 'routine');
    assert.strictEqual(fx.guardrailRows[0].agent_name, 'Suggestion scan', 'filed like the scan\'s own rows');
});

test('an own-server category in what a read returns is stripped before the model reads it', async () => {
    await run({ toolCall: { name: 'kb_search', args: { query: 'invoices' } }, readResult: { passage: `from ${SYNTH_EMAIL}` } });
    assert.strictEqual(fx.reads.length, 1);
    assertStripped(fx.toolOut);
});

test('no policy shield (routines kept out of the shield): the scan reads as before', async () => {
    await run({ shield: null, toolCall: { name: 'kb_search', args: { query: SYNTH_EMAIL } }, readResult: { passage: SYNTH_EMAIL } });
    assert.strictEqual(fx.reads.length, 1);
    assert.ok(fx.toolOut.includes(SYNTH_EMAIL));
    assert.deepStrictEqual(fx.guardrailRows, []);
});
