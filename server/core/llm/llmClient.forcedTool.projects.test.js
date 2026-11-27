// @typecheck
/**
 * The forced-tool contract of the LLM client (./llmClient.forcedTool.test.js) for the projects module's
 * participation gate: Claude 5.5 answers it as native JSON, without the forced tool_choice it does not support.
 * Moved out of llmClient.forcedTool.test.js unchanged; it belongs to the projects module.
 *
 * DB-free, like that file: the real configStore reads an empty `config` table through the shared pool double.
 *
 * Run: cd server && node --test core/llm/llmClient.forcedTool.projects.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const { useConfigRows } = require('../../testUtils/configRows');

const config = useConfigRows();
after(config.restore);

const llmClient = require('./llmClient');
const { claudeAdapter } = require('../providers/index');

/**
 * llmClient._resolve yields the Claude adapter, whose chat records its options and answers `chatResult`.
 * @param {any} adapter
 * @param {any} chatResult
 */
function stubResolve(adapter, chatResult) {
    /** @type {Array<{ messages: any, options: any }>} */
    const calls = [];
    const saved = { resolve: llmClient._resolve, chat: adapter.chat };
    adapter.chat = async (/** @type {any} */ _k, /** @type {any} */ _u, /** @type {any} */ _m, /** @type {any} */ messages, /** @type {any} */ options) => {
        calls.push({ messages, options });
        return chatResult;
    };
    llmClient._resolve = async () => ({ apiKey: 'k', baseUrl: '', adapter, providerType: adapter.name, modelId: 'm', project: null, location: null, serviceAccountKey: null });
    return { calls, restore() { llmClient._resolve = saved.resolve; adapter.chat = saved.chat; } };
}

test('Claude 5.5 participation uses native JSON without unsupported forced tool_choice', async () => {
    const { PARTICIPATION_TOOL } = require('../../projects/participation/relevanceGate');
    const s = stubResolve(claudeAdapter, { content: JSON.stringify({ should_reply: true }) });
    try {
        const out = await llmClient.chatForcedTool('claude-sonnet-5-5', [{ role: 'user', content: 'AI, can you help?' }], PARTICIPATION_TOOL);
        assert.equal(s.calls[0].options.toolChoice, undefined);
        assert.equal(s.calls[0].options.tools, undefined);
        assert.deepEqual(s.calls[0].options.responseFormat.json_schema.schema, PARTICIPATION_TOOL.function.parameters);
        assert.deepEqual(out.structured, { should_reply: true });
    } finally { s.restore(); }
});
