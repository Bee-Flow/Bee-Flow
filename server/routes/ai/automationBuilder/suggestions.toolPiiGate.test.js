/**
 * BFSF-354 — the ideas mode of "Find repeating work" lets a model read the
 * user's connected apps, one tool call at a time. Those reads honour the
 * Privacy Shield's tool block lists as chat does: a read whose arguments carry
 * a category on the "Outside tools" / "Own server" list is refused, and what
 * the model reads back has those categories stripped.
 *
 * The scan is not an automation: its policy is resolved with
 * honourAutomationOptOut false, so an org that keeps AUTOMATIONS out of the
 * shield still has a shielded scan, and its reads are filed under
 * `pattern_scan`.
 *
 * The route's collaborators are injected through createSuggestionsRouter; the
 * ideas scan and the scan reader are the real ones, with the model's tool loop
 * a stand-in that makes one call through the scan's own executor. The real
 * gate runs with its detector injected and the real orgShield classifies the
 * tools (its config store is the one stub left). Synthetic data.
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
const { pass } = require('../../../testUtils/suggestionsRouteHarness');

// The real orgShield (loaded by the gate for the tool classification) reads
// its config here.
const restore = installResolveStub({ '../../stores/configStore': configStoreStub() });

const { createSuggestionsRouter } = require('./suggestions');
const { runIdeasScan } = require('../../../automation/patterns/ideation');
const { makeScanReader } = require('../../../automation/patterns/scanReader');

injectEmailDetector(require('../../../core/privacy/toolPiiGate'));

const fx = { shield: null, toolCall: null, readResult: null, reads: [], toolOut: null, guardrailRows: [], policyCalls: [], egress: [] };
const resolveIntegration = (name) => ({ integration: name.split('_')[0] });

const llmClient = {
    // One round: the model reads fx.toolCall through the scan's executor.
    runToolLoop: async (_model, _messages, _tools, _opts, executeTool) => {
        fx.toolOut = await executeTool(fx.toolCall.name, fx.toolCall.args);
        return { toolCallRounds: 1, structured: null, content: '[]' };
    },
    chatForcedTool: async () => ({ structured: null, content: '' }),
};

const router = createSuggestionsRouter({
    requireAuth: pass, suggestRateLimit: pass, feedbackRateLimit: pass,
    userHasBetaFeature: async () => true,
    getIntegrationTools: async () => ({ tools: [{ type: 'function', function: { name: fx.toolCall.name } }] }),
    resolveIntegration,
    isEUModeActive: async () => ({ isEU: false }),
    resolveModelForTierName: async () => 'fast-model',
    llmClient,
    safety: {
        resolveAutomationPolicy: async (ctx, opts) => { fx.policyCalls.push(opts); return { shield: fx.shield }; },
        buildAuditBase: (ctx, _step, opts) => ({ source: opts.source, agent_name: ctx.automationTitle }),
        guardAiInput: async () => ({ blocked: false }),
    },
    scanCache: { deriveScopeKey: ({ userId }) => `user:${userId}`, getCachedScan: async () => null, upsertScan: async () => {} },
    makeScanReader: (ctx) => makeScanReader(ctx, {
        executeTool: async (name, args) => { fx.reads.push({ name, args }); return fx.readResult; },
        captureCall: async (fn) => { try { return { ok: true, value: await fn(), probe: null }; } catch (e) { return { ok: false, error: e }; } },
        logEgress: async (row) => { fx.egress.push(row); },
        logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); },
    }),
    runIdeasScan: (input) => runIdeasScan(input, {
        llmClient,
        isSideEffect: () => false,
        resolveIntegration,
        getIntegrationByTool: async () => [],
        getAutomations: async () => [],
        getRecentSuppressedTitles: async () => [],
        guardToolOutput: async (out) => ({ result: out, categories: [] }),
        guardAiInput: async () => ({ blocked: false }),
    }),
    logUsage: async () => {},
});

const baseUrl = serveRouter(test, router, { prefix: '/builder', session: SIGNED_IN, restore });

async function run({ shield = OWN_SERVER_EMAIL, toolCall, readResult = { ok: true } }) {
    resetFixture(fx, { shield, toolCall, readResult, toolOut: null });
    const res = await postJson(`${baseUrl()}/suggest`, { mode: 'ideas', integrationIds: [], force: true });
    assert.strictEqual(res.status, 200, res.body);
}

test('a read whose arguments carry an own-server category is refused, never made', async () => {
    await run({ toolCall: { name: 'kb_search', args: { query: `mail from ${SYNTH_EMAIL}` } } });
    assert.deepStrictEqual(fx.reads, [], 'a refused read must not run');
    assert.match(fx.toolOut, REFUSED_FOR_EMAIL);
    assertRefusalAudited(fx.guardrailRows, 'pattern_scan');
    assert.strictEqual(fx.guardrailRows[0].agent_name, 'Suggestion scan', 'filed like the scan\'s own rows');
});

test('an own-server category in what a read returns is stripped before the model reads it', async () => {
    await run({ toolCall: { name: 'kb_search', args: { query: 'invoices' } }, readResult: { passage: `from ${SYNTH_EMAIL}` } });
    assert.strictEqual(fx.reads.length, 1);
    assertStripped(fx.toolOut);
    assert.strictEqual(fx.egress[0].auditBase.source, 'pattern_scan', 'the read is on the ledger as the scan\'s own');
});

test('the scan keeps the shield even where automations are kept out of it', async () => {
    await run({ toolCall: { name: 'kb_search', args: { query: 'invoices' } } });
    assert.deepStrictEqual(fx.policyCalls, [{ honourAutomationOptOut: false }]);
});

test('no org shield at all: the scan reads as before', async () => {
    await run({ shield: null, toolCall: { name: 'kb_search', args: { query: SYNTH_EMAIL } }, readResult: { passage: SYNTH_EMAIL } });
    assert.strictEqual(fx.reads.length, 1);
    assert.ok(fx.toolOut.includes(SYNTH_EMAIL));
    assert.deepStrictEqual(fx.guardrailRows, []);
});
