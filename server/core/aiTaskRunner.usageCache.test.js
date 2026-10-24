/**
 * A scheduled run (automation or cowork) bills what the provider really reported,
 * cache included. executeTask read `response.usage.prompt_tokens` /
 * `completion_tokens` only, and the non-streaming Claude and Gemini adapters
 * returned the raw provider block, so a Claude or Gemini run logged 0 tokens at
 * 0 cost. The adapter here is the REAL one (only the SDK client is stubbed).
 *
 * Also: when the owner's integration tools fail to load, a plain-prompt run
 * falls back to the web search tools. The fallback used to require a
 * `buildAgentSearchTool` that agentSearchTools never exported, so it silently
 * left the run without any tool. The stub here has the REAL export shape.
 *
 * Run: node --test core/aiTaskRunner.usageCache.test.js
 */
require('../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');
const {
    realClaudeAdapter, realGeminiAdapter, assertClaudeEntry, assertGeminiEntry,
} = require('./providers/usageHarness');

const logged = [];
let adapter = null;
let integrationsDown = false;
const SEARCH_TOOL = { type: 'function', function: { name: 'agent_search', parameters: { type: 'object' } } };

const fakeStore = {
    markRunning: async () => {}, markCompleted: async () => {}, markError: async () => {},
    advanceSchedule: async () => {}, updateTask: async () => {},
};

const restore = installResolveStub({
    '../stores/coworkStore': {
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
        getIntegrationTools: async () => {
            if (integrationsDown) throw new Error('integrations down');
            return { tools: [] };
        },
        buildToolHint: async () => '',
    },
    './tools/toolDispatcher': { executeTool: async () => 'ok' },
    '../integrations/agentSearchTools': { AGENT_SEARCH_TOOLS: [SEARCH_TOOL] },
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
    await executeTask(TASK, { store: fakeStore });
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

test('integration tools failing to load leaves the web search tool on the run', async () => {
    const chatArgs = [];
    adapter = {
        chat: async (...args) => {
            chatArgs.push(JSON.stringify(args));
            return { content: 'Done.', usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
    };
    integrationsDown = true;
    try {
        await executeTask(TASK, { store: fakeStore });
    } finally {
        integrationsDown = false;
    }
    assert.ok(chatArgs.length > 0, 'the adapter was called');
    assert.ok(chatArgs[0].includes('agent_search'), 'the fallback search tool reached the model');
});
