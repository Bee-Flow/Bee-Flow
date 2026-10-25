// @typecheck
/**
 * Shared embedding dispatcher.
 *
 * Single Azure-aware embedding chain used by BOTH KB ingestion and the
 * node-search web-search pipeline, so both resolve embeddings identically:
 *   1. Global Embeddings provider (`ai.embeddingProviderId` / `embeddingModel`)
 *      — OpenAI-compatible APIs (OpenAI, Mistral, generic) and Azure.
 *   2. Legacy `azure_openai_embedding_*` configStore keys.
 *   3. In-process CPU embedder (Xenova/multilingual-e5-small, 384-dim).
 *
 * Returns { vectors, source, model } where vectors is [][] aligned with input
 * order. `source` is one of 'provider' | 'azure' | 'cpu' | null.
 */

const configStore = require('../../stores/configStore');
const { recordEmbedCall } = require('../../telemetry/metrics');
const log = require('../../telemetry/log');
const { toV1BaseUrl } = require('../../utils/azureUrl');

/**
 * One embedding request, retried while the failure is temporary.
 *
 * A large document is hundreds of batches in a row, and a provider's
 * per-minute quota (Azure's TPM, OpenAI's RPM) answers 429 somewhere in the
 * middle. Without a retry that one batch threw the whole document over to
 * the CPU embedder, whose 384-dimension vectors cannot be stored next to
 * the provider's ("expected 1536 dimensions, not 384"). A 429, a 5xx or a
 * timeout is waited out (Retry-After when the provider sends one); any
 * other status is a real error and fails at once.
 */
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];
const MAX_RETRY_AFTER_MS = 60000;
/**
 * @param {number} ms
 */
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Response} res
 */
function retryAfterMs(res) {
    const raw = res?.headers?.get?.('retry-after');
    if (!raw) return null;
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS) : null;
}

/**
 * @param {string} url
 * @param {string} label
 */
async function postEmbedBatch(url, init, label) {
    for (let attempt = 0; ; attempt++) {
        const last = attempt >= RETRY_DELAYS_MS.length;
        /** @type {Response} */
        let res;
        try {
            res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
        } catch (err) {
            // Timeout or connection reset: temporary by nature.
            if (last) throw err;
            log.warn(`[Embed] ${label} request failed (${/** @type {Error} */ (err).message}); retry ${attempt + 1}/${RETRY_DELAYS_MS.length}`);
            await sleep(RETRY_DELAYS_MS[attempt]);
            continue;
        }
        if (res.ok) return res.json();
        const errTxt = await res.text();
        const temporary = res.status === 429 || res.status >= 500;
        if (!temporary || last) {
            throw new Error(`${label} embed ${res.status}: ${errTxt.slice(0, 200)}`);
        }
        const wait = retryAfterMs(res) ?? RETRY_DELAYS_MS[attempt];
        log.warn(`[Embed] ${label} answered ${res.status}; retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${wait} ms`);
        await sleep(wait);
    }
}

/**
 * Generate embeddings via Azure OpenAI (legacy direct config).
 *
 * @param {string[]} texts — array of text strings to embed
 * @param {string} endpoint — Azure OpenAI endpoint
 * @param {string} apiKey — Azure OpenAI API key
 * @param {string} model — deployment name (e.g. 'text-embedding-3-small')
 * @returns {Promise<number[][]>} — array of embedding vectors
 */
async function azureEmbed(texts, endpoint, apiKey, model) {
    // Azure v1 GA: no api-version, the deployment name goes in the body as `model`.
    const url = `${toV1BaseUrl(endpoint)}/embeddings`;

    // Batch in groups of 16 to avoid rate limits
    const BATCH_SIZE = 16;
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);

        const data = await postEmbedBatch(url, {
            method: 'POST',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, input: batch }),
        }, 'Azure');
        const sorted = data.data
            .sort((a, b) => a.index - b.index)
            .map(item => item.embedding);
        allEmbeddings.push(...sorted);
    }

    return allEmbeddings;
}

/**
 * Prefixes for ASYMMETRIC embedding models.
 *
 * Some models embed a QUESTION and the PASSAGE that answers it into different
 * spaces unless you tell them which one they are looking at. EmbeddingGemma
 * (served locally by llama.cpp here) is one: it wants
 *   query    -> "task: search result | query: <text>"
 *   document -> "title: none | text: <text>"
 * Getting this wrong does not error — retrieval just quietly gets worse, which
 * is why it is handled centrally instead of at each call site.
 *
 * multilingual-e5 (the in-process CPU fallback) has the same property with
 * different spellings; cpuEmbed.js applies those itself, so we only pass `kind`
 * down to it.
 * @param {string[]} texts
 * @param {string} kind
 */
function applyModelPrefix(texts, modelId, kind) {
    const model = String(modelId || '').toLowerCase();
    if (/embedding-?gemma/.test(model)) {
        return kind === 'query'
            ? texts.map(t => `task: search result | query: ${t}`)
            : texts.map(t => `title: none | text: ${t}`);
    }
    // e5 models reached through an HTTP provider (rather than cpuEmbed) need
    // their own prefixes for the same reason.
    if (/(^|[^a-z])e5([^a-z]|$)|multilingual-e5/.test(model)) {
        return texts.map(t => `${kind === 'query' ? 'query' : 'passage'}: ${t}`);
    }
    return texts;
}

/**
 * Dispatch an embedding call through the configured chain (provider → Azure → CPU).
 *
 * @param {string[]} texts
 * @param {{kind?: 'query'|'passage', strict?: boolean}} [options]
 *   'passage' (the default, and what every caller got before this existed) is
 *   for text being STORED; 'query' is for text being SEARCHED WITH. On a
 *   symmetric model the distinction is a no-op — but on an asymmetric one,
 *   embedding a query as a passage is a silent quality loss.
 *   `strict`: the configured provider or nothing. Its failure is thrown
 *   instead of falling through to Azure or the CPU embedder, whose vectors
 *   live in a different space (and usually a different dimension). For work
 *   that must not mix models: re-embedding the stored vectors after a model
 *   switch (core/kb/embeddingMigration.js).
 */
async function dispatchEmbedTexts(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return { vectors: [], source: null, model: null };
    const kind = options.kind === 'query' ? 'query' : 'passage';
    const strict = options.strict === true;
    // Why the configured provider was passed over, for a caller that cannot
    // use a fallback's vectors and has to say why (core/kb/localKBIngest.js).
    /** @type {string | null} */
    let providerError = null;

    // (1) Configured global provider via resolveEmbedTarget
    try {
        const { resolveEmbedTarget } = require('./resolveTarget');
        const target = await resolveEmbedTarget();
        // A self-hosted runtime (Ollama, vLLM, llama.cpp, …) normally has no
        // API key at all, so requiring one here silently skipped every local
        // embedding provider and fell through to the CPU embedder. Local
        // targets are accepted keyless; everything else still needs a key.
        const { isLocalProviderType } = require('../providers/localModels');
        const targetUsable = !!target?.endpoint && !!target?.modelId
            && (!!target.apiKey || isLocalProviderType(target.providerType));
        if (targetUsable) {
            const root = target.endpoint.replace(/\/+$/, '');
            const isAzure = target.providerType === 'azure';
            // Azure v1 GA: `<origin>/openai/v1/embeddings`, no api-version,
            // the deployment name travels as `model` in the body like everywhere else.
            const url = isAzure
                ? `${toV1BaseUrl(target.endpoint)}/embeddings`
                : (root.endsWith('/v1') ? `${root}/embeddings` : `${root}/v1/embeddings`);

            const BATCH = 16;
            const out = [];
            const prepared = applyModelPrefix(texts, target.modelId, kind);
            for (let i = 0; i < prepared.length; i += BATCH) {
                const batch = prepared.slice(i, i + BATCH);
                // An empty `Bearer ` header is rejected outright by some
                // servers, so a keyless local target sends no auth header.
                const headers = isAzure
                    ? { 'Content-Type': 'application/json', 'api-key': target.apiKey }
                    : {
                        'Content-Type': 'application/json',
                        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
                    };
                const body = JSON.stringify({ model: target.modelId, input: batch });
                const data = await postEmbedBatch(url, { method: 'POST', headers, body }, target.providerName || target.providerType || 'provider');
                const sorted = (data.data || []).sort((a, b) => a.index - b.index).map(e => e.embedding);
                out.push(...sorted);
            }
            log.info(`[Embed] Embeddings via ${target.providerName || target.providerType} / ${target.modelId} (dim=${out[0]?.length})`);
            recordEmbedCall({ source: 'provider', status: 'ok' });
            return { vectors: out, source: 'provider', model: target.modelId };
        }
    } catch (err) {
        if (strict) throw err;
        providerError = /** @type {Error} */ (err).message;
        log.warn(`[Embed] Configured provider embed failed (${/** @type {Error} */ (err).message}); falling through to Azure/CPU`);
    }
    if (strict) throw new Error('No usable embedding provider is configured');

    // (2) Legacy azure_openai_embedding_* config
    const azureEndpoint = await configStore.getConfig('azure_openai_embedding_endpoint');
    const azureKey = await configStore.getSecret('azure_openai_embedding_key');
    const azureModel = await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small';
    if (azureEndpoint && azureKey) {
        try {
            const out = await azureEmbed(texts, azureEndpoint, azureKey, azureModel);
            log.info(`[Embed] Embeddings via legacy Azure config / ${azureModel} (dim=${out[0]?.length})`);
            recordEmbedCall({ source: 'azure', status: 'ok' });
            return { vectors: out, source: 'azure', model: azureModel, providerError };
        } catch (err) {
            log.warn(`[Embed] Legacy Azure embed failed (${/** @type {Error} */ (err).message}); falling through to CPU`);
        }
    }

    // (3) CPU in-process fallback (Xenova/multilingual-e5-small, 384-dim)
    try {
        const { cpuEmbed } = require('./cpuEmbed');
        const vectors = await cpuEmbed(texts, { kind });
        if (vectors.length > 0) {
            log.info(`[Embed] Embeddings via in-process CPU embedder (dim=${vectors[0]?.length})`);
            recordEmbedCall({ source: 'cpu', status: 'ok' });
            return { vectors, source: 'cpu', model: 'multilingual-e5-small', providerError };
        }
    } catch (err) {
        log.warn(`[Embed] CPU embed failed (${/** @type {Error} */ (err).message})`);
    }

    recordEmbedCall({ source: 'none', status: 'error' });
    return { vectors: [], source: null, model: null, providerError };
}

// An embedding call is a model call, whoever runs it (kb_search, the memory
// tools): its socket is not the destination of the tool that happened to
// need a vector. Same rule as the provider adapters (providers/index.js).
const { outsideProbe } = require('../http/egressCapture');

module.exports = {
    dispatchEmbedTexts: (texts, options) => outsideProbe(() => dispatchEmbedTexts(texts, options)),
    azureEmbed: (texts, endpoint, apiKey, model) => outsideProbe(() => azureEmbed(texts, endpoint, apiKey, model)),
    applyModelPrefix,
    // Tests replace the backoff wait so a retry costs no wall-clock time.
    _setSleepForTests: (fn) => { sleep = fn; },
};

/**
 * @typedef {{ data: { index: number, embedding: number[] }[] }} EmbedResponse
 */
