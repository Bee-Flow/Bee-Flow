/**
 * core/memory/extractionModel — model + request shape for the memory extractors.
 *
 * The config store and the tier resolver are mocked through the require
 * cache (same pattern as core/agentRuntime/contextBuilder.test.js) so this
 * runs without Postgres.
 *
 * Run: cd server && node --test --test-force-exit core/memory/extractionModel.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-session-secret-0123456789abcdef';

function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const state = { config: undefined, configThrows: false, resolverCalls: [] };
mock('../../stores/configStore', {
    getConfig: async (key) => {
        if (state.configThrows) throw new Error('db down');
        return key === 'memory_extraction_model' ? state.config : undefined;
    },
});
mock('../llm/modelResolver', {
    resolveModelWithGlobalFallback: async (rawModel, opts) => {
        state.resolverCalls.push({ rawModel, opts });
        return rawModel ? `resolved(${rawModel})` : 'fast-tier-model';
    },
});

const {
    resolveMemoryExtractionModel, EXTRACTION_CHAT_OPTIONS, EXTRACTION_MAX_CHARS, MEMORY_EXTRACTION_MODEL_KEY,
} = require('./extractionModel');

test.beforeEach(() => { state.config = undefined; state.configThrows = false; state.resolverCalls = []; });

test('the dedicated key wins over everything, trimmed', async () => {
    state.config = '  qwen2.5:1.5b  ';
    const model = await resolveMemoryExtractionModel({ agentModel: 'tier:thinking', userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(model, 'qwen2.5:1.5b');
    assert.strictEqual(state.resolverCalls.length, 0, 'the tier resolver is not consulted');
    assert.strictEqual(MEMORY_EXTRACTION_MODEL_KEY, 'memory_extraction_model');
});

test('unset / blank key falls back to the agent model through the Fast tier', async () => {
    for (const blank of [undefined, null, '', '   ', 42]) {
        state.config = blank;
        state.resolverCalls = [];
        const model = await resolveMemoryExtractionModel({ agentModel: 'tier:fast', userOrgId: 'org1', userId: 'u1' });
        assert.strictEqual(model, 'resolved(tier:fast)', String(blank));
        assert.deepStrictEqual(state.resolverCalls, [{ rawModel: 'tier:fast', opts: { userOrgId: 'org1', userId: 'u1', fallbackTier: 'fast' } }]);
    }
});

test('no agent model at all → the Fast tier', async () => {
    const model = await resolveMemoryExtractionModel({ userOrgId: null });
    assert.strictEqual(model, 'fast-tier-model');
    assert.deepStrictEqual(state.resolverCalls[0], { rawModel: null, opts: { userOrgId: null, userId: null, fallbackTier: 'fast' } });
});

test('a config-store failure does not stop extraction', async () => {
    state.configThrows = true;
    const model = await resolveMemoryExtractionModel({ agentModel: 'm' });
    assert.strictEqual(model, 'resolved(m)');
});

test('the request shape: thinking off, small cap, stall timeout, frozen', () => {
    assert.strictEqual(EXTRACTION_CHAT_OPTIONS.reasoningEffort, 'none');
    assert.strictEqual(EXTRACTION_CHAT_OPTIONS.budgetTokens, 0);
    assert.strictEqual(EXTRACTION_CHAT_OPTIONS.maxTokens, 1024);
    assert.ok(EXTRACTION_CHAT_OPTIONS.timeoutMs >= 30_000);
    assert.ok(Object.isFrozen(EXTRACTION_CHAT_OPTIONS));
    // Spreading first, then adding temperature, is the calling convention.
    const opts = { ...EXTRACTION_CHAT_OPTIONS, temperature: 0.1 };
    assert.strictEqual(opts.reasoningEffort, 'none');
    assert.strictEqual(opts.temperature, 0.1);
});

test('the context budgets: the user side carries the facts', () => {
    assert.deepStrictEqual({ ...EXTRACTION_MAX_CHARS }, { user: 8000, assistant: 4000 });
    assert.ok(EXTRACTION_MAX_CHARS.user < 20000, 'was 20,000 per side');
});
