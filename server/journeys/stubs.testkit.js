// @typecheck
/**
 * The stand-ins of the journeys' world (journeyWorld.testkit.js): the
 * scripted model behind the real provider adapters, the deterministic KB
 * embedder, the price list, and the SSE reader the journeys use.
 *
 * Not a test file: required by journeyWorld.testkit.js and the journeys.
 */

'use strict';

/**
 * The price list of the journeys' world, USD per 1M tokens: the stub model
 * (STUB_MODEL) at a rate a journey can read back on the usage row.
 */
const STUB_MODEL = 'gpt-4o';
const PRICES = { [STUB_MODEL]: { input: 2.5, output: 10, provider: 'openai' } };

/**
 * The provider adapters' network methods, answered from a script. Swapped on
 * every adapter instance getAdapter can return, so no provider type (a
 * self-hosted runtime included) reaches past it.
 *
 * `model.reply` decides the answer text from the messages (default: a fixed
 * sentence that names the last user message); `model.calls` records every
 * call: which adapter, which model, and the messages it was sent.
 *
 * @param {ReturnType<typeof import('../testUtils/swaps').makeSwaps>} swaps
 */
function stubModel(swaps) {
    const providers = require('../core/providers');
    const adapters = new Set([
        providers.openaiAdapter, providers.mistralAdapter, providers.claudeAdapter, providers.googleAdapter,
        providers.googleVertexAdapter, providers.azureAdapter, providers.scalewayAdapter, providers.ionosAdapter,
        providers.eugptAdapter, providers.baseAdapter, ...Object.values(providers.localAdapters),
    ]);
    /** @type {Array<{ adapter: string, method: string, model: string, messages: any[] }>} */
    const calls = [];
    const model = {
        calls,
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
        /** @param {any[]} messages */
        reply: (messages) => {
            const last = [...messages].reverse().find((m) => m.role === 'user');
            const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
            return `Stub answer to: ${text.slice(-120)}`;
        },
    };
    for (const adapter of adapters) {
        if (!adapter) continue;
        const name = String(adapter.name || 'adapter');
        swaps.swap(adapter, 'listModels', async () => (adapter === providers.openaiAdapter ? [{ id: STUB_MODEL, name: STUB_MODEL }] : []));
        swaps.swap(adapter, 'chat', async (/** @type {string} */ _key, /** @type {string} */ _url, /** @type {string} */ modelId, /** @type {any[]} */ messages) => {
            calls.push({ adapter: name, method: 'chat', model: modelId, messages });
            return { content: model.reply(messages), toolCalls: null, usage: { ...model.usage } };
        });
        swaps.swap(adapter, 'stream', async (/** @type {string} */ _key, /** @type {string} */ _url, /** @type {string} */ modelId, /** @type {any[]} */ messages, /** @type {unknown} */ _opts, /** @type {(t: string, d: unknown) => void} */ onEvent) => {
            calls.push({ adapter: name, method: 'stream', model: modelId, messages });
            onEvent('text', { text: model.reply(messages) });
            onEvent('done', { ...model.usage, stop_reason: 'stop' });
        });
    }
    return model;
}

/**
 * A deterministic embedder behind the KB pipeline's own seam (`wire()` of
 * core/kb/localIngest and localSearch): a 64-dimension bag of hashed words,
 * so the same words land near each other and nothing is fetched.
 */
function stubEmbedder() {
    // Loaded first: it wires the real dispatcher into both modules at load.
    require('../core/kb/localKBIngest');
    /** @param {string[]} texts */
    const dispatchEmbedTexts = async (texts) => ({
        vectors: texts.map((t) => {
            const v = new Array(64).fill(0);
            for (const w of String(t).toLowerCase().split(/\W+/).filter(Boolean)) {
                let hash = 0;
                for (const ch of w) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
                v[hash % 64] += 1;
            }
            const norm = Math.hypot(...v) || 1;
            return v.map((x) => x / norm);
        }),
        source: 'journey-stub',
        model: 'journey-stub-embedder',
    });
    require('../core/kb/localIngest').wire({ dispatchEmbedTexts, loadEmbeddingMigration: () => require('../core/kb/embeddingMigration') });
    require('../core/kb/localSearch').wire({ dispatchEmbedTexts });
}

/**
 * `event: x\ndata: {...}` frames, as sseHelpers writes them; a frame with only
 * `data:` is reported as event `message`.
 * @param {string} raw
 */
function parseSse(raw) {
    /** @type {Array<{ event: string, data: any }>} */
    const out = [];
    for (const frame of raw.split('\n\n')) {
        const lines = frame.split('\n');
        const event = lines.find((l) => l.startsWith('event: '))?.slice(7) || 'message';
        const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
        if (!dataLines.length) continue;
        const text = dataLines.join('\n');
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        out.push({ event, data });
    }
    return out;
}

module.exports = { stubModel, stubEmbedder, parseSse, STUB_MODEL, PRICES };
