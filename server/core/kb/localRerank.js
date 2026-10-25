// @typecheck
/**
 * Phase 2 of a local KB search: the reranker chain (llama.cpp > Azure Cohere >
 * CPU cross-encoder > GPU sidecar > RRF passthrough), and `applyRerank`, the
 * one function every branch reorders through.
 */

const { recordSidecarCall } = require('../../telemetry/metrics');
const { getServiceHeaders } = require('../serviceAuth');
const log = require('../../telemetry/log');

// Collaborators that sit in the server's large import cycle are handed in by
// the barrel (localKBIngest.js) through wire(), so this module imports none of
// them itself and the cycle does not grow (lint:scc-ratchet). Lazy ones stay
// lazy: the barrel passes a loader, called where the require used to be.
let configStore = null;
let loadLlamaCppRerank = null;
function wire(deps) {
    ({ configStore, loadLlamaCppRerank } = deps);
}

/**
 * Re-order the candidate rows by a reranker's verdict, KEEPING each row whole.
 *
 * ── WHY THIS IS A FUNCTION AND NOT FOUR MAP CALLS ───────────────────
 * All four reranker branches (Azure Cohere, the CPU cross-encoder, the GPU
 * sidecar, and the GPU retry inside the CPU branch) used to rebuild the row
 * from four fields: `{ content, title, source_uri, score }`. Everything else
 * was dropped — `id`, `document_id`, `chunk_id`, and anything a later column
 * adds.
 *
 * That is what made a citation unable to say more than the document's TITLE.
 * "Personeelshandboek" is not a citation; "Personeelshandboek, p. 12" is, and
 * the id needed to fetch that passage back had been thrown away one line after
 * the database returned it. A reranker's only job is to say WHICH rows and in
 * what ORDER — it has no business editing them.
 *
 * @param {Array} rows      the candidates, in the order the reranker saw them
 * @param {Array} ranked    `[{ index, relevance_score }]` from the reranker
 * @returns {Array} the same row objects, reordered, carrying the new score
 */
function applyRerank(rows, ranked) {
    const out = [];
    for (const r of ranked || []) {
        const row = rows[r?.index];
        // An index the reranker invented, or one for a row we no longer have,
        // is skipped rather than becoming an `undefined` in the results.
        if (!row) continue;
        out.push({ ...row, score: r.relevance_score });
    }
    return out;
}

/**
 * Rerank the fused candidates of a search. Holds no DB connection: the
 * caller released its own before calling.
 *
 * @param {Array} candidates  the RRF-ordered rows
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<Array>} the rows in the reranker's order, or the
 *   candidates unchanged when no reranker answered
 */
async function rerankCandidates(candidates, query, topK) {
    let results = candidates;
    // ── Phase 2: Reranking — no DB connection held during these API calls ──
    // Priority: Azure Cohere (provider) > CPU cross-encoder (in-process) >
    // local GPU vLLM sidecar (`RERANKER_URL`) > RRF passthrough.
    // CPU branch sits ahead of the GPU sidecar so users without a GPU box
    // get a working reranker by default; existing GPU users are unaffected.
    const azureRerankerEndpoint = await configStore.getConfig('azure_reranker_endpoint') || process.env.AZURE_RERANKER_ENDPOINT;
    const azureRerankerKey = await configStore.getSecret('azure_reranker_key') || process.env.AZURE_RERANKER_KEY;
    const azureRerankerModel = await configStore.getConfig('azure_reranker_model') || process.env.AZURE_RERANKER_MODEL || 'Cohere-rerank-v4.0-fast';
    const localRerankerUrl = process.env.RERANKER_URL;
    // Admin opt-in for the CPU cross-encoder. Default true so fresh installs
    // get reranking out of the box; admins who want only Azure or only GPU
    // can disable it via `cpu_reranker_enabled = false`.
    const cpuRerankerEnabled = (await configStore.getConfig('cpu_reranker_enabled')) !== false;
    // Opt-in (config `llamacpp_rerank_enabled`), so no existing install changes
    // behaviour. When an admin has turned it on they have a local GPU
    // cross-encoder that is both better and cheaper than the alternatives, so it
    // goes first — and it keeps the query on the box, which the cloud tier does
    // not. Returns [] on any failure, which falls through to the tiers below.
    const { rerankLlamaCpp, isEnabled: llamaCppRerankEnabled } = loadLlamaCppRerank();
    const useLlamaCppRerank = results.length > 0 && await llamaCppRerankEnabled();
    let llamaCppReranked = false;
    if (useLlamaCppRerank) {
        const t0 = Date.now();
        const scored = await rerankLlamaCpp(query, results.map(r => r.content), topK);
        if (scored.length > 0) {
            results = applyRerank(results, scored);
            llamaCppReranked = true;
            log.info(`[LocalKBSearch] llama.cpp reranked ${scored.length} results in ${Date.now() - t0}ms (top=${results[0]?.score?.toFixed(3)})`);
        } else {
            log.warn('[LocalKBSearch] llama.cpp rerank returned nothing; falling through');
        }
    }

    if (llamaCppReranked) {
        // already ranked above
    } else if (azureRerankerEndpoint && azureRerankerKey && results.length > 0) {
        // ── Azure Cohere rerank (primary — no GPU required) ──
        try {
            const rrEndpoint = azureRerankerEndpoint.replace(/\/+$/, '');
            const requestBody = JSON.stringify({
                model: azureRerankerModel,
                query,
                documents: results.map(r => r.content),
                top_n: topK,
            });
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${azureRerankerKey}`,
            };

            // Try paths in order of likelihood — cache the working one
            const RERANK_PATHS = ['/providers/cohere/v2/rerank', '/v1/rerank', '/v2/rerank'];
            if (!global._azureRerankerPath) global._azureRerankerPath = null;

            const pathsToTry = global._azureRerankerPath
                ? [global._azureRerankerPath]
                : RERANK_PATHS;

            let rerankerData = null;
            for (const path of pathsToTry) {
                const url = `${rrEndpoint}${path}`;
                log.info(`[LocalKBSearch] Trying Azure reranker: ${url} (model=${azureRerankerModel}, docs=${results.length})`);
                const res = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: requestBody,
                    signal: AbortSignal.timeout(15000),
                });
                if (res.ok) {
                    rerankerData = await res.json();
                    global._azureRerankerPath = path;  // cache for future calls
                    break;
                }
                const errBody = await res.text().catch(() => '');
                log.warn(`[LocalKBSearch] Azure reranker ${path} → ${res.status}: ${errBody.slice(0, 200)}`);
                if (res.status === 401 || res.status === 403) break; // auth issue, no point trying other paths
            }

            if (rerankerData?.results?.length > 0) {
                results = applyRerank(results, rerankerData.results);
                log.info(`[LocalKBSearch] Azure Cohere reranked ${rerankerData.results.length} results (top=${results[0]?.score})`);
            } else if (!rerankerData) {
                log.warn(`[LocalKBSearch] All Azure reranker paths failed, falling back to RRF`);
            }
        } catch (rerankerErr) {
            log.warn(`[LocalKBSearch] Azure reranker error (${/** @type {Error} */ (rerankerErr).message}), falling back to RRF`);
        }
    } else if (cpuRerankerEnabled && results.length > 0) {
        // ── CPU cross-encoder (Transformers.js, MIT bge-reranker-base) ──
        // Runs in-process; first call lazy-loads the model (~280 MB).
        // Returns early if the pipeline is unavailable so we still try
        // the GPU sidecar (next branch) before falling back to RRF.
        try {
            const { rerankCpu } = require('../rerank/cpuCrossEncoder');
            const scored = await rerankCpu(query, results.map(r => r.content), topK);
            if (scored.length > 0) {
                results = applyRerank(results, scored);
            } else if (localRerankerUrl) {
                // Fall through to GPU sidecar
                throw new Error('CPU reranker unavailable, trying GPU sidecar');
            }
        } catch (cpuErr) {
            if (localRerankerUrl) {
                log.warn(`[LocalKBSearch] CPU rerank failed (${/** @type {Error} */ (cpuErr).message}); trying GPU sidecar`);
                // Fall through by re-running the GPU branch below
                try {
                    const rerankerRes = await fetch(`${localRerankerUrl}/rerank`, {
                        method: 'POST',
                        headers: getServiceHeaders(),
                        body: JSON.stringify({ query, documents: results.map(r => r.content), top_n: topK }),
                        signal: AbortSignal.timeout(10000),
                    });
                    if (rerankerRes.ok) {
                        const rerankerData = await rerankerRes.json();
                        if (rerankerData.results && rerankerData.results.length > 0) {
                            results = applyRerank(results, rerankerData.results);
                        }
                    }
                } catch (gpuErr) {
                    log.warn(`[LocalKBSearch] GPU sidecar also failed (${/** @type {Error} */ (gpuErr).message}); using RRF`);
                }
            } else {
                log.warn(`[LocalKBSearch] CPU rerank failed (${/** @type {Error} */ (cpuErr).message}); using RRF`);
            }
        }
    } else if (localRerankerUrl && results.length > 0) {
        // ── Local GPU cross-encoder sidecar (only when Azure is NOT configured) ──
        const rerankT0 = Date.now();
        try {
            const rerankerRes = await fetch(`${localRerankerUrl}/rerank`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    query,
                    documents: results.map(r => r.content),
                    top_n: topK,
                }),
                signal: AbortSignal.timeout(10000),
            });

            if (rerankerRes.ok) {
                recordSidecarCall({ service: 'rerank', status: 'ok', durationMs: Date.now() - rerankT0 });
                const rerankerData = await rerankerRes.json();
                if (rerankerData.results && rerankerData.results.length > 0) {
                    results = applyRerank(results, rerankerData.results);
                    log.info(`[LocalKBSearch] Local GPU reranked ${rerankerData.results.length} results in ${rerankerData.latency_ms || '?'}ms (top=${results[0]?.score})`);
                }
            } else {
                recordSidecarCall({ service: 'rerank', status: 'error', durationMs: Date.now() - rerankT0 });
                log.warn(`[LocalKBSearch] Local GPU reranker responded ${rerankerRes.status}, falling back to RRF`);
            }
        } catch (rerankerErr) {
            recordSidecarCall({ service: 'rerank', status: 'error', durationMs: Date.now() - rerankT0 });
            log.warn(`[LocalKBSearch] Local GPU reranker unavailable (${/** @type {Error} */ (rerankerErr).message}), falling back to RRF`);
        }
    } else {
        log.info('[LocalKBSearch] No reranker configured — using RRF scores');
    }

    return results;
}

module.exports = { applyRerank, rerankCandidates, wire };

/** @typedef {typeof globalThis & { _azureRerankerPath?: string | null }} AzureRerankerGlobal */
