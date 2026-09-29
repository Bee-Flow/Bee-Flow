/**
 * The tier that produced an agent's model travels with the model id.
 *
 * Only this resolver knows which tier was used — it is either the one the agent
 * declared or the one the classifier picked. Dropping it forced the caller to
 * reverse-map the model id back to a tier, and that guess is ambiguous the
 * moment two tiers share one model: on a self-hosted box with a single good
 * model ALL tiers do, so the settings came from whichever key `chat_model_tiers`
 * happened to be stored under first (Postgres jsonb: shortest key wins, i.e.
 * `pro`). Agents then ran on Deep Thinking's ceiling and reasoning effort
 * without anyone configuring it.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/modelResolver.tierCarry.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

// All six tiers on one model — the self-hosted shape this bug lived in.
const ONE_MODEL_TIERS = {
    pro: { modelId: 'gemma-4-26b-a4b', maxTokens: 12288, reasoningEffort: 'high' },
    fast: { modelId: 'gemma-4-26b-a4b', maxTokens: 2048, reasoningEffort: 'none' },
    thinking: { modelId: 'gemma-4-26b-a4b', maxTokens: 8192, reasoningEffort: 'medium' },
};

let classifierTier = 'thinking';

const restore = installResolveStub({
    '../aiAgent': { resolveModelId: (m) => m || 'global-default' },
    '../../stores/configStore': {
        getConfig: async (key) => (key === 'chat_model_tiers' ? ONE_MODEL_TIERS : null),
    },
    '../entitlements/userTiers': { getPermittedTierKeys: async () => new Set(Object.keys(ONE_MODEL_TIERS)) },
    '../llm/promptClassifier': {
        classifyWithLLM: async () => ({ tier: classifierTier, method: 'stub', reason: 'test' }),
    },
});
after(restore);

const { resolveAgentModel, resolveAgentModelWithTier } = require('./modelResolver');
const GLOBAL = { model: 'global-default' };

test('a declared tier is reported back, not re-derived from the model', async () => {
    const out = await resolveAgentModelWithTier('tier:thinking', 'hello', GLOBAL);
    assert.deepStrictEqual(out, { modelId: 'gemma-4-26b-a4b', tierKey: 'thinking' });
});

test('every declared tier keeps its own identity even though they share a model', async () => {
    for (const key of ['fast', 'thinking', 'pro']) {
        const out = await resolveAgentModelWithTier(`tier:${key}`, 'hello', GLOBAL);
        assert.strictEqual(out.tierKey, key, `tier:${key} resolved as ${out.tierKey}`);
    }
});

test('auto reports the tier the classifier actually picked', async () => {
    classifierTier = 'thinking';
    assert.strictEqual((await resolveAgentModelWithTier('tier:auto', 'analyse this', GLOBAL)).tierKey, 'thinking');
    classifierTier = 'fast';
    assert.strictEqual((await resolveAgentModelWithTier('tier:auto', 'hi', GLOBAL)).tierKey, 'fast');
});

test('auto falling back to the fast safety net says so', async () => {
    // The classifier named a tier that is not configured: the model comes from
    // `fast`, so the reported tier has to be `fast` too — naming the requested
    // tier would apply settings the run never used.
    classifierTier = 'writer';
    const out = await resolveAgentModelWithTier('tier:auto', 'write something', GLOBAL);
    assert.strictEqual(out.modelId, 'gemma-4-26b-a4b');
    assert.strictEqual(out.tierKey, 'fast');
    classifierTier = 'thinking';
});

test('an unconfigured declared tier reports no tier at all', async () => {
    // Falls through to the global default model; there are no tier settings to
    // apply, and null says exactly that.
    const out = await resolveAgentModelWithTier('tier:writer', 'hello', GLOBAL);
    assert.deepStrictEqual(out, { modelId: 'global-default', tierKey: null });
});

test('a non-tier model still resolves through auto', async () => {
    classifierTier = 'fast';
    const out = await resolveAgentModelWithTier('some-raw-model', 'hi', GLOBAL);
    assert.strictEqual(out.modelId, 'gemma-4-26b-a4b');
    assert.strictEqual(out.tierKey, 'fast');
    classifierTier = 'thinking';
});

test('resolveAgentModel keeps returning a bare string for its existing callers', async () => {
    const out = await resolveAgentModel('tier:thinking', 'hello', GLOBAL);
    assert.strictEqual(out, 'gemma-4-26b-a4b');
    assert.strictEqual(typeof out, 'string');
});
