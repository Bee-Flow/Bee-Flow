/**
 * summaryHelpers — smart-tier model resolution.
 *
 * Regression: resolveSmartModel asked for the 'thinking' tier whenever no
 * hand-written 'smart' key existed, but resolveModelForTierName hardcodes
 * fallbackTier:'fast' — so an install without a configured thinking tier
 * silently ran meeting summaries on the FAST model. The tier map must be
 * inspected for BOTH candidates before asking the resolver.
 *
 * llmClient / modelResolver / speakerEvidence are require-cache stubbed — no
 * DB, no LLM. Run: cd server && node --test core/meetingNotes/summaryHelpers.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let currentTiers = {};
const resolveCalls = [];

stub('../llm/llmClient', { chat: async () => ({ content: '' }) });
stub('./speakerEvidence', { extractSpeakerEvidence: async () => null });
stub('../llm/modelResolver', {
    getEUAwareTiers: async () => currentTiers,
    resolveModelForTierName: async (tierName) => {
        resolveCalls.push(tierName);
        // Mirrors the real resolver's hardcoded fast fallback: an unconfigured
        // tier silently yields the fast model.
        return currentTiers[tierName]?.modelId || currentTiers.fast?.modelId || 'fast-model';
    },
});

const { resolveSmartModel } = require('./summaryHelpers');

test.beforeEach(() => { resolveCalls.length = 0; });

test('a hand-written smart tier wins', async () => {
    currentTiers = { smart: { modelId: 'claude-fable-5' }, thinking: { modelId: 'think-1' }, fast: { modelId: 'flash' } };
    assert.strictEqual(await resolveSmartModel('org-1'), 'claude-fable-5');
    assert.deepStrictEqual(resolveCalls, ['smart']);
});

test('falls back to the thinking tier when smart is absent', async () => {
    currentTiers = { thinking: { modelId: 'think-1' }, fast: { modelId: 'flash' } };
    assert.strictEqual(await resolveSmartModel('org-1'), 'think-1');
    assert.deepStrictEqual(resolveCalls, ['thinking']);
});

test('neither smart nor thinking configured → explicit fallback, NEVER the fast model', async () => {
    currentTiers = { fast: { modelId: 'flash-lite' } };
    const model = await resolveSmartModel('org-1');
    assert.strictEqual(model, 'gemini-2.0-flash');
    assert.notStrictEqual(model, 'flash-lite');
    // The resolver must not even be asked — its hardcoded fast fallback is the bug.
    assert.deepStrictEqual(resolveCalls, []);
});

test('empty tier map → explicit fallback', async () => {
    currentTiers = {};
    assert.strictEqual(await resolveSmartModel(null), 'gemini-2.0-flash');
});
