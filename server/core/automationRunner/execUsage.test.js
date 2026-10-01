/**
 * Automation steps that call a model (ai_step, parse_json in ai mode,
 * data_extraction) bill what the provider really reported, cache included.
 *
 * Each of them read `usage.promptTokens || usage.prompt_tokens ||
 * usage.input_tokens`, and the non-streaming Claude and Gemini adapters
 * returned the raw block (cache fields nobody read, Gemini's `usageMetadata`
 * spelled differently again), so a routine on either provider logged zero cost
 * and dropped the cache. The adapter here is the REAL one; llmClient is real
 * too; only the SDK client and the stores are stubbed.
 *
 * Run: node --test core/automationRunner/execUsage.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const {
    realClaudeAdapter, realGeminiAdapter, assertClaudeEntry, assertGeminiEntry,
} = require('../providers/usageHarness');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let adapter = null;
const usageRows = [];

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {
    getConfig: async (k) => (k === 'data_extraction_model' ? 'model-extract' : null),
    setConfig: async () => {},
    getSecret: async () => null,
    setSecret: async () => {},
});
mock('../../stores/notificationStore', { createNotification: async () => {} });
mock('../../db', { pool: {} });
mock('../../stores/userStore', { getUser: async (id) => ({ id, email: 'owner@acme.nl', organizationId: 'org1' }) });
// The real module (llmClient asks `adapter instanceof googleAdapter.constructor`
// through it); only the lookup returns the scripted adapter.
mock('../providers', { ...require('../providers'), getAdapter: () => adapter });
mock('../aiAgent', {
    getProviderForModel: async () => ({ providerType: 'stub', url: 'https://llm.example.com', apiKey: 'k' }),
    getAIConfig: async () => ({ model: 'test-model' }),
});
mock('../llm/modelResolver', {
    getUserTierMap: async () => ({ fast: { modelId: 'test-model' } }),
    resolveModelForTierName: async () => 'test-model',
});
mock('../entitlements/userTiers', { getPermittedTierKeys: async () => new Set(['fast']) });
mock('../../stores/usageStore', { logUsage: async (row) => { usageRows.push(row); } });
mock('../../stores/terminationStore', { logTermination: async () => {} });
mock('../../automation/shapeCache', { recordShape: async () => {} });
mock('./safety', {
    resolveAutomationPolicy: async () => ({ action: 'off', privacyScope: 'external' }),
    buildAuditBase: () => ({}),
    guardAiInput: async () => ({ tokenMap: {}, blocked: false }),
    guardAiOutput: async (content) => ({ content, tokenMap: {} }),
    restoreForRunState: (v) => v,
    buildPiiSummary: () => null,
    prepareForEgress: (v) => v,
    logEgress: async () => {},
});

const { execAiStep, execParseJson, execDataExtraction } = require('./engine');

const state = () => ({ trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] });
const ctx = () => ({ userId: 'u1', orgId: 'org1', automationId: 'a1', runId: 'r1' });
const flush = () => new Promise((r) => setImmediate(r));

const aiStep = { id: 'a1', type: 'ai_step', modelTier: 'fast', prompt: 'Summarise.' };
const parseStep = {
    id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.s1.output.doc',
    fields: [{ name: 'naam', path: 'naam', type: 'string' }],
};
const extractStep = {
    id: 'x1', type: 'data_extraction', source: { kind: 'ref', path: 'steps.s1.output.doc' },
    fields: [{ name: 'naam', type: 'string', description: 'Customer name' }],
};
const withDoc = () => {
    const st = state();
    st.steps.s1 = { output: { doc: { tekst: 'Jan de Vries' } }, status: 'success' };
    return st;
};

test('ai_step on Claude: tokens, cache read/write and the 5m/1h split reach the usage row', async () => {
    usageRows.length = 0;
    adapter = realClaudeAdapter([{ text: 'A summary.' }]);
    await execAiStep(aiStep, ctx(), state(), 'live');
    await flush();
    assert.strictEqual(usageRows.length, 1);
    assert.strictEqual(usageRows[0].source, 'routine');
    assertClaudeEntry(usageRows[0]);
});

test('ai_step on Gemini: tokens, thoughts and cache reach the usage row', async () => {
    usageRows.length = 0;
    adapter = realGeminiAdapter([{ text: 'A summary.' }]);
    await execAiStep(aiStep, ctx(), state(), 'live');
    await flush();
    assert.strictEqual(usageRows.length, 1);
    assertGeminiEntry(usageRows[0]);
});

test('parse_json (ai) on Claude: the forced-tool call is billed with its cache', async () => {
    usageRows.length = 0;
    adapter = realClaudeAdapter([{ toolUse: { name: '*', input: { naam: 'Jan de Vries' } } }]);
    const out = await execParseJson(parseStep, ctx(), withDoc(), 'live');
    await flush();
    assert.strictEqual(out.output.naam, 'Jan de Vries');
    assert.strictEqual(usageRows.length, 1);
    assertClaudeEntry(usageRows[0]);
});

test('parse_json (ai) on Gemini: the forced-tool call is billed', async () => {
    usageRows.length = 0;
    adapter = realGeminiAdapter([{ toolUse: { name: '*', input: { naam: 'Jan de Vries' } } }]);
    await execParseJson(parseStep, ctx(), withDoc(), 'live');
    await flush();
    assert.strictEqual(usageRows.length, 1);
    assertGeminiEntry(usageRows[0]);
});

test('data_extraction on Claude: the extraction call is billed with its cache', async () => {
    usageRows.length = 0;
    adapter = realClaudeAdapter([{ text: '{"naam":"Jan de Vries"}' }]);
    const out = await execDataExtraction(extractStep, ctx(), withDoc(), 'live');
    await flush();
    assert.deepStrictEqual(out.output, { naam: 'Jan de Vries' });
    assert.strictEqual(usageRows.length, 1);
    assertClaudeEntry(usageRows[0]);
});

test('data_extraction on Gemini: the extraction call is billed', async () => {
    usageRows.length = 0;
    adapter = realGeminiAdapter([{ text: '{"naam":"Jan de Vries"}' }]);
    await execDataExtraction(extractStep, ctx(), withDoc(), 'live');
    await flush();
    assert.strictEqual(usageRows.length, 1);
    assertGeminiEntry(usageRows[0]);
});
