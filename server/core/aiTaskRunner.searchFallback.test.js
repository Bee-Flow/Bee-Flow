/**
 * When the owner's integration tools fail to load, a plain-prompt run falls
 * back to the web search tools. The fallback used to require a
 * `buildAgentSearchTool` that agentSearchTools never exported, so it silently
 * left the run without any tool. The stub here has the REAL export shape.
 *
 * Run: node --test core/aiTaskRunner.searchFallback.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const SEARCH_TOOL = { type: 'function', function: { name: 'agent_search', parameters: { type: 'object' } } };
const chatArgs = [];

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
    './providers': {
        getAdapter: () => ({
            chat: async (...args) => {
                chatArgs.push(JSON.stringify(args));
                return { content: 'Done.', usage: { prompt_tokens: 1, completion_tokens: 1 } };
            },
        }),
    },
    './integrations/integrationTools': {
        getIntegrationTools: async () => { throw new Error('integrations down'); },
        buildToolHint: async () => '',
    },
    './tools/toolDispatcher': { executeTool: async () => 'ok' },
    '../integrations/agentSearchTools': { AGENT_SEARCH_TOOLS: [SEARCH_TOOL] },
    '../stores/notificationStore': { createNotification: async () => {} },
    '../utils/appPaths': { coworkTaskPath: (id) => `/app/cowork/${id}` },
    '../stores/usageStore': { logUsage: async () => {} },
});
after(() => restore());

const { executeTask } = require('./aiTaskRunner');

test('integration tools failing to load leaves the web search tool on the run', async () => {
    await executeTask({ id: 't1', userId: 'u1', modelTier: 'fast', title: 'T', prompt: 'Do something.' });
    assert.ok(chatArgs.length > 0, 'the adapter was called');
    assert.ok(chatArgs[0].includes('agent_search'), 'the fallback search tool reached the model');
});
