/**
 * Reranking via the local llama.cpp router (bge-reranker-v2-m3 on the GPU).
 *
 * Same job as cpuCrossEncoder.js, but the model is served by the llama.cpp
 * router already running for chat, so it costs no extra process and about
 * 0.5 GB of GPU memory. bge-reranker-v2-m3 is multilingual, which matters here:
 * the corpus is Dutch, German, English and French.
 *
 *   POST {base}/v1/rerank
 *   {"model":"bge-reranker-v2-m3","query":"…","documents":["…"],"top_n":3}
 *   -> {"results":[{"index":0,"relevance_score":4.35}, …]}
 *
 * THE SCORES ARE RAW LOGITS, NOT PROBABILITIES. Measured on this box: a
 * matching passage scored +4.35 while unrelated ones scored -11.02. Downstream
 * code compares against 0..1 thresholds — knowledgeSearch.js filters at 0.72
 * and notebookKnowledgeSearch.js at 0.15/0.2/0.25 — so handing those a logit
 * would let anything above +0.72 through and silently bin every genuinely
 * relevant passage scoring between 0 and 0.72. We therefore sigmoid here,
 * exactly as cpuCrossEncoder.js already does with its own cross-encoder logits,
 * and emit the same {index, relevance_score} shape so `applyRerank` is unchanged.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

// The server runs in Docker; llama.cpp is a host process.
const DEFAULT_URL = 'http://host.docker.internal:8080';
const DEFAULT_MODEL = 'bge-reranker-v2-m3';
const TIMEOUT_MS = Number(process.env.LLAMACPP_RERANK_TIMEOUT_MS) || 15_000;

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

async function getSettings() {
    const enabled = (await configStore.getConfig('llamacpp_rerank_enabled')) === true
        || process.env.LLAMACPP_RERANK_ENABLED === '1';
    const url = (await configStore.getConfig('llamacpp_rerank_url')) || process.env.LLAMACPP_RERANK_URL || DEFAULT_URL;
    const model = (await configStore.getConfig('llamacpp_rerank_model')) || process.env.LLAMACPP_RERANK_MODEL || DEFAULT_MODEL;
    return { enabled, base: String(url).replace(/\/+$/, ''), model };
}

/** Whether an admin has turned this on. Cheap: config only, no network. */
async function isEnabled() {
    return (await getSettings()).enabled;
}

/**
 * Rerank documents against a query.
 *
 * @param {string} query
 * @param {string[]} documents
 * @param {number} [topN]
 * @returns {Promise<Array<{index:number, relevance_score:number}>>}
 *   Sorted descending, relevance_score in 0..1. Empty array on ANY failure so
 *   the caller falls through to its next tier (never throws).
 */
async function rerankLlamaCpp(query, documents, topN) {
    if (!query || !Array.isArray(documents) || documents.length === 0) return [];
    const { enabled, base, model } = await getSettings();
    if (!enabled) return [];

    try {
        const res = await fetch(`${base}/v1/rerank`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                query,
                documents,
                top_n: Math.max(1, Math.min(Number(topN) || documents.length, documents.length)),
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            log.warn(`[LlamaCppRerank] ${res.status}: ${body.slice(0, 200)}`);
            return [];
        }
        const data = await res.json();
        const rows = Array.isArray(data?.results) ? data.results : [];
        const scored = rows
            // An index outside the input array is the server disagreeing with us
            // about what it was sent; dropping it beats scoring the wrong row.
            .filter(r => Number.isInteger(r?.index) && r.index >= 0 && r.index < documents.length)
            .map(r => ({
                index: r.index,
                relevance_score: typeof r.relevance_score === 'number' ? sigmoid(r.relevance_score) : 0,
            }));
        scored.sort((a, b) => b.relevance_score - a.relevance_score);
        return scored;
    } catch (err) {
        log.warn(`[LlamaCppRerank] unavailable (${err.message})`);
        return [];
    }
}

module.exports = { rerankLlamaCpp, isEnabled, _internals: { sigmoid, getSettings } };
