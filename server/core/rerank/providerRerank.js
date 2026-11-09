// @typecheck strict
/**
 * Reranking through a configured LLM provider record.
 *
 * Generic for every host that speaks the OpenAI/Cohere/Jina-style rerank API
 * (IONOS AI Model Hub, vLLM, ...):
 *
 *   POST {base}/v1/rerank          (a base that already ends in /v1 is not doubled)
 *   Authorization: Bearer <provider api key>
 *   {"model":"…","query":"…","documents":["…"],"top_n":3,"return_documents":false}
 *   -> {"results":[{"index":0,"relevance_score":0.93}, …], "usage":{"prompt_tokens":…,"total_tokens":…}}
 *
 * The scores are already 0..1 (calibrated), so they are passed through as is.
 * Unlike rerankLlamaCpp this THROWS on any failure; the caller (localRerank.js)
 * logs it and falls through to the next tier.
 */

const configStore = require('../../stores/configStore');
const { safeFetch } = require('../../utils/ssrfGuard');
const log = require('../../telemetry/log');

// Unset or not a positive number: the default. Never `|| n`, which turns a set 0 into n.
const ENV_TIMEOUT_MS = Number(process.env.PROVIDER_RERANK_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(ENV_TIMEOUT_MS) && ENV_TIMEOUT_MS > 0 ? ENV_TIMEOUT_MS : 15_000;
// The documented upper bound of the IONOS endpoint (1..1000); harmless elsewhere.
const MAX_DOCUMENTS = 1000;

/** @param {string} base */
function rerankUrl(base) {
    const trimmed = String(base).trim().replace(/\/+$/, '');
    return /\/v1$/.test(trimmed) ? `${trimmed}/rerank` : `${trimmed}/v1/rerank`;
}

/**
 * @param {string} providerId
 * @param {(key: string) => Promise<unknown>} getConfig
 * @returns {Promise<{ url: string, apiKey: string | null, type: string | null }>}
 */
async function resolveProvider(providerId, getConfig) {
    const ai = /** @type {{ providers?: Array<{ id: string, url?: string, apiKey?: string, type?: string }> }} */ (
        (await getConfig('ai')) || {});
    const provider = (ai.providers || []).find(p => p.id === providerId);
    if (!provider) throw new Error(`Rerank provider "${providerId}" not found`);
    if (!provider.url) throw new Error(`Rerank provider "${providerId}" has no URL`);
    return { url: provider.url, apiKey: provider.apiKey || null, type: provider.type || null };
}

/**
 * Best-effort usage row for the billed input tokens. Never fails the rerank.
 * @param {string} model
 * @param {{ prompt_tokens?: number, total_tokens?: number } | undefined} usage
 * @param {(entry: Record<string, unknown>) => Promise<unknown>} logUsage
 */
async function logRerankUsage(model, usage, logUsage) {
    if (!usage) return;
    try {
        const prompt = Number(usage.prompt_tokens) || 0;
        await logUsage({
            agent_id: null,
            agent_name: 'system',
            model,
            prompt_tokens: prompt,
            completion_tokens: 0,
            total_tokens: Number(usage.total_tokens) || prompt,
            source: 'knowledge_rerank',
        });
    } catch (err) {
        log.warn('[ProviderRerank] Failed to log rerank usage:', /** @type {Error} */ (err).message);
    }
}

/**
 * @param {Array<{ index?: unknown, relevance_score?: unknown }>} results
 * @param {number} count
 * @returns {Array<{ index: number, score: number }>}
 */
function mapResults(results, count) {
    /** @type {Array<{ index: number, score: number }>} */
    const scored = [];
    for (const r of results) {
        const index = r?.index;
        // An index outside the input is the server disagreeing about what it was sent.
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) continue;
        scored.push({ index, score: typeof r.relevance_score === 'number' ? r.relevance_score : 0 });
    }
    return scored;
}

/**
 * @typedef {{
 *   getConfig: (key: string) => Promise<unknown>,
 *   fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean, status: number, text(): Promise<string>, json(): Promise<unknown> }>,
 *   logUsage: (entry: Record<string, unknown>) => Promise<unknown>,
 * }} ProviderRerankDeps
 */

/** @type {ProviderRerankDeps} */
const DEFAULT_DEPS = {
    getConfig: (key) => configStore.getConfig(key),
    fetch: (url, init) => safeFetch(url, init),
    // Lazy: the usage store is not needed until a rerank actually reports tokens.
    logUsage: (entry) => require('../../stores/usageStore').logUsage(entry),
};

/**
 * @param {{ providerId: string, model: string, query: string, documents: string[], topN?: number }} args
 * @param {Partial<ProviderRerankDeps>} [overrides] injected collaborators (tests)
 * @returns {Promise<Array<{ index: number, score: number }>>} best first, score 0..1
 */
async function providerRerank({ providerId, model, query, documents, topN }, overrides = {}) {
    const deps = { ...DEFAULT_DEPS, ...overrides };
    if (!query || !Array.isArray(documents) || documents.length === 0) return [];
    if (documents.length > MAX_DOCUMENTS) documents = documents.slice(0, MAX_DOCUMENTS);
    const { url, apiKey } = await resolveProvider(providerId, deps.getConfig);

    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await deps.fetch(rerankUrl(url), {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model,
            query,
            documents,
            top_n: Math.max(1, Math.min(Number(topN) || documents.length, documents.length)),
            return_documents: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Rerank ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = /** @type {{ results?: Array<{ index?: unknown, relevance_score?: unknown }>, usage?: { prompt_tokens?: number, total_tokens?: number } } | null} */ (await res.json());
    if (!data || !Array.isArray(data.results)) throw new Error('Rerank response has no results array');

    await logRerankUsage(model, data.usage, deps.logUsage);

    const scored = mapResults(data.results, documents.length);
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

module.exports = { providerRerank, _internals: { rerankUrl } };
