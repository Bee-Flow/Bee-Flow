// @typecheck strict
'use strict';
/**
 * A harness for tests that run execAiStep end to end with every outside
 * dependency faked: the tier/model resolution, the provider, llmClient, the
 * Privacy Shield guard (a tokenising one: it swaps configured names for
 * placeholders on the way out and back on the way in) and the usage store.
 *
 *   const h = installAiStepHarness({ names: { 'Jan Jansen': '[person_1]' } });
 *   const { execAiStep } = h.load();         // AFTER install, never before
 *   h.forced = async (modelId, messages, toolDef, options) => ({ structured: {...}, usage: {...} });
 *   ...
 *   after(() => h.restore());
 *
 * What the model was sent is recorded as deep copies at call time:
 * h.forcedCalls (llmClient.chatForcedTool) and h.chatCalls (adapter.chat).
 */

const { installResolveStub } = require('./stubRequire');
const { forcedToolViaChat } = require('./forcedToolViaChat');

const clone = (/** @type {unknown} */ v) => JSON.parse(JSON.stringify(v));

/**
 * @param {unknown} value
 * @param {string[][]} pairs
 * @returns {unknown}
 */
function replaceDeep(value, pairs) {
    if (typeof value === 'string') return pairs.reduce((s, [from, to]) => s.split(from).join(to), value);
    if (Array.isArray(value)) return value.map((x) => replaceDeep(x, pairs));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, pairs)]));
    return value;
}

/**
 * @param {{ names?: Record<string, string>, tiers?: Record<string, any>, extraStubs?: Record<string, any>, realLlm?: boolean, adapterExtras?: Record<string, any> }} [opts]
 *   names: real value -> placeholder the guard swaps in (and the restore swaps back)
 *   realLlm: run the REAL llmClient (and provider limiter) on top of the fake adapter,
 *     which then also carries `adapterExtras` (e.g. supportsStructuredOutput)
 */
function installAiStepHarness({ names = {}, tiers, extraStubs = {}, realLlm = false, adapterExtras = {} } = {}) {
    /** @type {any} */
    const h = {
        chatCalls: [], forcedCalls: [], usageRows: [], guardInputs: [],
        /** adapter.chat: (apiKey, url, modelId, messages, options) => reply */
        chat: async () => ({ content: '{}', usage: {} }),
        /** llmClient.chatForcedTool: set it, or leave it to answer through h.chat */
        forced: null,
        /** a dry run under a block policy: guardAiInput refuses messages holding this text */
        blockWhenInputHas: null,
        restore: () => {},
        load: () => require('../core/automationRunner/execAi'),
    };
    const toPlaceholder = Object.entries(names);
    const toReal = Object.entries(names).map(([real, token]) => [token, real]);
    /**
     * @param {unknown} key
     * @param {unknown} url
     * @param {string} modelId
     * @param {unknown[]} messages
     * @param {Record<string, unknown>} options
     */
    const fakeChat = async (key, url, modelId, messages, options) => {
        h.chatCalls.push({ modelId, options: clone(options), forwardedRateLimit: 'rateLimit' in options, messages: clone(messages) });
        return h.chat(key, url, modelId, messages, options);
    };
    const viaChat = forcedToolViaChat(fakeChat);
    /**
     * @param {string} modelId
     * @param {unknown[]} messages
     * @param {Record<string, unknown>} toolDef
     * @param {{ rateLimit?: { signal?: AbortSignal }, [key: string]: unknown }} [options]
     */
    const forcedTool = async (modelId, messages, toolDef, options = {}) => {
        h.forcedCalls.push({ modelId, messages: clone(messages), toolDef: clone(toolDef), options: clone({ ...options, rateLimit: undefined }), hadSignal: !!(options.rateLimit && 'signal' in options.rateLimit) });
        return h.forced ? h.forced(modelId, messages, toolDef, options) : viaChat(modelId, messages, toolDef, options);
    };
    const adapter = { name: 'test', chat: fakeChat, ...adapterExtras };
    const safety = {
        async resolveAutomationPolicy() { return { action: 'tokenize', privacyScope: 'external' }; },
        buildAuditBase() { return {}; },
        /** @param {Array<{ role: string, content: string }>} messages */
        async guardAiInput(messages) {
            h.guardInputs.push(clone(messages));
            const targets = messages.filter((m) => (m.role === 'user' || m.role === 'system') && typeof m.content === 'string');
            if (h.blockWhenInputHas && targets.some((m) => m.content.includes(h.blockWhenInputHas))) return { blocked: true, categories: ['Test'] };
            for (const m of targets) m.content = /** @type {string} */ (replaceDeep(m.content, toPlaceholder));
            return { tokenMap: {}, blocked: false };
        },
        async guardAiOutput(/** @type {string} */ content) { return { content, categories: /** @type {string[]} */ ([]) }; },
        restoreForRunState: (/** @type {unknown} */ v) => replaceDeep(v, toReal),
        /** @type {() => Record<string, unknown> | null} */
        buildPiiSummary: () => null,
    };
    h.restore = installResolveStub({
        '../llm/modelResolver': { async getUserTierMap() { return tiers || { fast: { modelId: 'model-fast', maxTokens: 4096 } }; } },
        '../entitlements/userTiers': { async getPermittedTierKeys() { return /** @type {string[] | null} */ (null); } },
        '../llm/promptClassifier': { async classifyWithLLM() { return { tier: 'fast' }; } },
        '../aiAgent': {
            async getProviderForModel(/** @type {string} */ modelId) { return { apiKey: 'k', url: 'https://llm.example.test', providerType: 'test', modelId }; },
            async getAIConfig() { return { model: 'model-fast' }; },
        },
        '../providers': { getAdapter: () => adapter },
        ...(realLlm
            ? { '../providers/index': { getAdapter: () => adapter, GoogleProvider: class {}, LocalProvider: class {} } }
            : { '../llm/llmClient': { chatForcedTool: forcedTool } }),
        './safety': safety,
        '../../stores/usageStore': { async logUsage(/** @type {Record<string, unknown>} */ row) { h.usageRows.push(row); } },
        '../../stores/terminationStore': { async logTermination() {} },
        ...extraStubs,
    });
    return h;
}

/**
 * A run state with the given steps (outputs) and a warnings list.
 * @param {Record<string, unknown>} [steps]
 * @param {Record<string, unknown>} [vars]
 */
function runStateWith(steps = {}, vars = {}) {
    return {
        trigger: { output: {} },
        steps: Object.fromEntries(Object.entries(steps).map(([id, output]) => [id, { output, status: 'success' }])),
        vars, secrets: {}, loop: {}, _templateWarnings: /** @type {string[]} */ ([]),
    };
}

module.exports = { installAiStepHarness, runStateWith };
