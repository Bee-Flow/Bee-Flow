/**
 * A scheduled run (routine or cowork) bills what the provider really reported,
 * cache included. executeTask read `response.usage.prompt_tokens` /
 * `completion_tokens` only, and the non-streaming Claude and Gemini adapters
 * returned the raw provider block, so a Claude or Gemini run logged 0 tokens at
 * 0 cost. The adapter here is the REAL one (only the SDK client is stubbed).
 *
 * Run: node --test core/aiTaskRunner.usageCache.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');
const {
    realClaudeAdapter, realGeminiAdapter, assertClaudeEntry, assertGeminiEntry,
} = require('./providers/usageHarness');

const logged = [];
let adapter = null;

const fakeStore = {
    markRunning: async () => {}, markCompleted: async () => {}, markError: async () => {},
    advanceSchedule: async () => {}, updateTask: async () => {},
};

const restore = installResolveStub({
    '../stores/aiTaskStore': {
        markRunning: async () => {}, markCompleted: async () => {},
        markError: async () => {}, getDueTasks: async () => [],
        updateTask: async () => {}, advanceSchedule: async () => {},
    },
    '../db': { pool: { query: async () => ({ rows: [] }) } },
    '../stores/terminationStore': { logTermination: async () => {} },
    './llm/modelResolver': {
        resolveModelForTier: async () => 'model-x',
        resolveEffectiveOrgId: async () => 'org-eff',
        TIER_DEFAULTS: { fast: {}, thinking: {} },
    },
    './aiAgent': {
        getProviderForModel: async () => ({ providerType: 'stub', url: 'http://stub', apiKey: 'k' }),
    },
    './providers': { getAdapter: () => adapter },
    './integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [] }),
        buildToolHint: async () => '',
    },
    './tools/toolDispatcher': { executeTool: async () => 'ok' },
    '../integrations/agentSearchTools': { buildAgentSearchTool: () => null },
    '../stores/notificationStore': { createNotification: async () => {} },
    '../utils/appPaths': { coworkTaskPath: (id) => `/app/cowork/${id}` },
    '../stores/usageStore': { logUsage: async (entry) => { logged.push(entry); } },
});
after(() => restore());

const { executeTask } = require('./aiTaskRunner');
const flush = () => new Promise((r) => setImmediate(r));
const TASK = { id: 't1', userId: 'u1', modelTier: 'fast', title: 'T', prompt: 'Do something.' };

test('a Claude run logs real tokens, cache read/write and the 5m/1h split', async () => {
    logged.length = 0;
    adapter = realClaudeAdapter([{ text: 'Done.' }]);
    await executeTask(TASK, { store: fakeStore, surface: 'cowork' });
    await flush();
    assert.strictEqual(logged.length, 1, 'one usage row per run');
    assertClaudeEntry(logged[0]);
    assert.strictEqual(logged[0].total_tokens, 200);
});

test('a Gemini run logs real tokens, thoughts and cache', async () => {
    logged.length = 0;
    adapter = realGeminiAdapter([{ text: 'Done.' }]);
    await executeTask(TASK, { store: fakeStore });
    await flush();
    assert.strictEqual(logged.length, 1);
    assertGeminiEntry(logged[0]);
});

test('a Vertex run is accounted like a Gemini run', async () => {
    logged.length = 0;
    adapter = realGeminiAdapter([{ text: 'Done.' }], { vertex: true });
    await executeTask(TASK, { store: fakeStore });
    await flush();
    assert.strictEqual(logged.length, 1);
    assertGeminiEntry(logged[0]);
});
