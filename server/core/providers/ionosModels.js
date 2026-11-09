// @typecheck strict
/**
 * IONOS AI Model Hub — model catalog + served-model registry.
 *
 * IONOS AI Model Hub is a German, EU-hosted, OpenAI-compatible inference
 * service (one region: Berlin) billed per 1M tokens. Same job split as
 * ./scalewayModels.js, in one dependency-free module so adapters, cost
 * accounting and route handlers can all require it without a cycle:
 *
 *  1. CATALOG: display name, category, capability flags and list price for the
 *     models IONOS serves. `/v1/models` returns bare ids only.
 *
 *  2. REQUEST SHAPING FACTS: which models accept `reasoning_effort`, and the
 *     output cap where one is known.
 *
 *  3. SERVED-MODEL REGISTRY: which ids are served by an IONOS provider, so cost
 *     accounting bills them at IONOS's tariff and never fuzzy-matches another
 *     host that sells the same open weights.
 *
 * Only a few served ids were verified exactly (`openai/gpt-oss-120b`,
 * `meta-llama/Llama-3.3-70B-Instruct`, the embedding and rerank ids). The rest
 * are matched by a NORMALISED name (see normalizeIonosName): each entry lists
 * the normalised names it answers to in `match`. An id that matches no entry
 * falls back to the generic open-weight guess and carries NO price: a price is
 * never guessed.
 *
 * Prices: EUR per 1M tokens excl. VAT, ionos.de price list, 2026-11-09.
 */

// The only region. Accepted with or without the trailing /v1 anywhere a base
// URL is taken.
const IONOS_BASE_URL = 'https://openai.inference.de-txl.ionos.com/v1';

// gpt-oss has no "off" switch; this is the standard vocabulary for it. The Qwen
// models get no effort at all (the vocabulary is not documented, and an
// unsupported value is a 400).
const EFFORT_GPT_OSS = Object.freeze(['low', 'medium', 'high']);

/**
 * `match`: normalised names (see normalizeIonosName) a served id may carry.
 * `org`: vendor segment of the pricing key (`ionos/<org>/<id>`).
 * `context` / `maxOutput` are only set where IONOS states them.
 *
 * @typedef {{ org: string, name: string, cat: string, match: readonly string[], desc?: string,
 *   context?: number, maxOutput?: number, reasoning?: boolean, vision?: boolean, tools?: boolean,
 *   embedding?: boolean, rerank?: boolean, dims?: number, ocr?: boolean, effort?: readonly string[],
 *   status?: string, retires?: string, price?: { input: number, output: number, cacheRead?: number } | null }} IonosModelEntry
 */

/** @type {Record<string, IonosModelEntry>} */
const IONOS_MODELS = {
    'qwen3.5-9b': {
        org: 'Qwen', name: 'Qwen3.5 9B', cat: 'Reasoning',
        match: ['qwen3-5-9b'],
        context: 262_144, reasoning: true, tools: true, vision: true,
        price: { input: 0.10, output: 0.15 },
    },
    'qwen3.8-27b': {
        org: 'Qwen', name: 'Qwen3.8 27B', cat: 'Reasoning',
        match: ['qwen3-8-27b'],
        context: 262_144, reasoning: true, tools: true, vision: true,
        price: { input: 0.40, output: 2.70 },
    },
    'qwen3.5-397b-a17b': {
        org: 'Qwen', name: 'Qwen3.5 397B A17B', cat: 'Reasoning',
        match: ['qwen3-5-397b-a17b'],
        reasoning: true, tools: true, vision: true,
        price: { input: 0.60, output: 3.60 },
    },
    'mistral-small-24b': {
        org: 'mistralai', name: 'Mistral Small 24B', cat: 'Vision',
        match: ['mistral-small-24b', 'mistral-small-3-2-24b'],
        vision: true,
        price: { input: 0.10, output: 0.30 },
    },
    'gpt-oss-120b': {
        org: 'openai', name: 'gpt-oss 120B', cat: 'Reasoning',
        match: ['gpt-oss-120b'],
        reasoning: true, effort: EFFORT_GPT_OSS,
        price: { input: 0.15, output: 0.65 },
    },
    'llama-3.3-70b': {
        org: 'meta-llama', name: 'Llama 3.3 70B Instruct', cat: 'General',
        match: ['llama-3-3-70b'],
        price: { input: 0.65, output: 0.65 },
    },
    'qwen3-coder-next': {
        org: 'Qwen', name: 'Qwen3 Coder Next 80B', cat: 'Code',
        match: ['qwen3-coder-next', 'qwen3-coder-next-80b'],
        price: { input: 0.15, output: 0.80 },
    },
    'lightonocr-2': {
        org: 'lightonai', name: 'LightOnOCR 2', cat: 'Vision',
        match: ['lightonocr-2', 'lightonocr-2-1b'],
        vision: true, ocr: true,
        price: { input: 0.15, output: 0.30 },
    },
    // ── Embeddings ───────────────────────────────────────────────────────────
    'bge-m3': {
        org: 'BAAI', name: 'BGE-M3', cat: 'Embedding',
        match: ['bge-m3'],
        embedding: true, dims: 1024,
        price: { input: 0.02, output: 0 },
    },
    'qwen3-vl-embedding-8b': {
        org: 'Qwen', name: 'Qwen3-VL Embedding 8B', cat: 'Embedding',
        match: ['qwen3-vl-embedding-8b'],
        embedding: true,
        price: { input: 0.10, output: 0 },
    },
    // Retires 2026-11-30; no price known, so none is stored.
    'paraphrase-multilingual-mpnet-base-v2': {
        org: 'sentence-transformers', name: 'Paraphrase Multilingual MPNet', cat: 'Embedding',
        match: ['paraphrase-multilingual-mpnet-base-v2'],
        embedding: true, dims: 768, status: 'retiring', retires: '2026-11-30',
        price: null,
    },
    // ── Reranking (/v1/rerank, priced on input tokens only) ──────────────────
    'qwen3-vl-reranker-8b': {
        org: 'Qwen', name: 'Qwen3-VL Reranker 8B', cat: 'Rerank',
        match: ['qwen3-vl-reranker-8b'],
        rerank: true,
        price: { input: 0.04, output: 0 },
    },
};

/** normalised match name -> catalog key */
const MATCH_INDEX = new Map();
for (const [key, entry] of Object.entries(IONOS_MODELS)) {
    for (const m of entry.match) MATCH_INDEX.set(m, key);
}

/**
 * Normalise a served model id for catalog matching: lower-case, no `org/`
 * prefix, `.` `_` and spaces folded to `-`, and trailing release/format
 * suffixes (-instruct, -fp8, -2507, ...) dropped.
 * @param {string | undefined} modelId
 */
function normalizeIonosName(modelId) {
    if (!modelId || typeof modelId !== 'string') return '';
    let s = modelId.trim();
    const slash = s.lastIndexOf('/');
    if (slash >= 0) s = s.slice(slash + 1);
    s = s.toLowerCase().replace(/[._\s]+/g, '-');
    let prev;
    do {
        prev = s;
        s = s.replace(/-(instruct|chat|it|fp8|fp4|bf16|awq|gptq|int4|int8|\d{4})$/, '');
    } while (s !== prev);
    return s;
}

/**
 * Raw catalog entry for a served id, or null when it is not a model we know.
 * @param {string | undefined} modelId
 * @returns {IonosModelEntry | null}
 */
function getIonosModel(modelId) {
    const key = MATCH_INDEX.get(normalizeIonosName(modelId));
    return key ? IONOS_MODELS[key] : null;
}

/**
 * Describe an IONOS model. Always returns an object: an id outside the catalog
 * gets the open-weight family guess from ./localModels.js (and no price).
 * @param {string} modelId
 */
function describeIonosModel(modelId) {
    const entry = getIonosModel(modelId);
    if (entry) {
        return {
            id: modelId,
            name: entry.name,
            cat: entry.cat,
            desc: entry.desc || '',
            context: entry.context ?? null,
            maxOutput: entry.maxOutput ?? null,
            reasoning: !!entry.reasoning,
            vision: !!entry.vision,
            tools: !!entry.tools,
            embedding: !!entry.embedding,
            rerank: !!entry.rerank,
            dims: entry.dims ?? null,
            audio: false,
            status: entry.status || 'ga',
            ionos: true,
        };
    }

    const { describeLocalModel } = require('./localModels');
    const guess = describeLocalModel(modelId);
    return {
        id: modelId,
        name: guess.name,
        cat: guess.cat,
        desc: '',
        context: null,
        maxOutput: null,
        reasoning: guess.reasoning,
        vision: guess.vision,
        tools: guess.tools,
        embedding: guess.embedding,
        rerank: false,
        dims: null,
        audio: false,
        status: 'ga',
        ionos: true,
    };
}

/**
 * The `reasoning_effort` to send, or null to omit the parameter. Only gpt-oss
 * has a known vocabulary; every other model gets none (an unsupported value is
 * a 400 that fails the whole call).
 * @param {string | undefined} modelId
 * @param {string | null | undefined} requested
 * @returns {string | null}
 */
function normalizeReasoningEffort(modelId, requested) {
    if (!requested) return null;
    const allowed = getIonosModel(modelId)?.effort;
    if (!allowed) return null;
    return allowed.includes(requested) ? requested : null;
}

/**
 * Cap an output-token request at the model's cap where one is known; otherwise
 * pass it through.
 * @param {string | undefined} modelId
 * @param {unknown} requested
 * @returns {number | undefined}
 */
function clampMaxTokens(modelId, requested) {
    const n = Number(requested);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const cap = getIonosModel(modelId)?.maxOutput;
    return cap ? Math.min(n, cap) : n;
}

/**
 * Pricing key (`ionos/<org>/<id without org>`) for a catalogued model, or null
 * for an id outside the catalog. Looked up EXACTLY, never fuzzily.
 * @param {string | undefined} modelId
 */
function ionosPricingKey(modelId) {
    const entry = getIonosModel(modelId);
    if (!entry || typeof modelId !== 'string') return null;
    const slash = modelId.trim().lastIndexOf('/');
    const bare = (slash >= 0 ? modelId.trim().slice(slash + 1) : modelId.trim()).toLowerCase();
    return `ionos/${entry.org}/${bare}`;
}

/**
 * IONOS's published list price per 1M tokens (EUR), or null when the model is
 * not in the catalog or has no known price.
 * @param {string | undefined} modelId
 * @returns {{ input: number, output: number, cacheRead: number } | null}
 */
function getIonosListPrice(modelId) {
    const price = getIonosModel(modelId)?.price;
    if (!price) return null;
    return { input: price.input, output: price.output, cacheRead: price.cacheRead ?? 0 };
}

// ─── Served-model registry (pins cost accounting to IONOS's tariff) ──────────
const MAX_REGISTERED = 1000;
/** @type {Set<string>} */
const _ionosModelIds = new Set();

/**
 * Record that `modelId` is currently served by an IONOS provider.
 * @param {string | undefined} modelId
 */
function registerIonosModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return;
    if (_ionosModelIds.has(modelId)) return;
    if (_ionosModelIds.size >= MAX_REGISTERED) {
        const oldest = _ionosModelIds.values().next().value;
        if (oldest !== undefined) _ionosModelIds.delete(oldest);
    }
    _ionosModelIds.add(modelId);
}

/**
 * True when the model is known to be served by an IONOS provider.
 * @param {string | undefined} modelId
 */
function isIonosServedModel(modelId) {
    return !!modelId && _ionosModelIds.has(modelId);
}

/** Test seam: drops every registration. */
function _resetIonosModelRegistry() {
    _ionosModelIds.clear();
}

module.exports = {
    IONOS_BASE_URL,
    IONOS_MODELS,
    normalizeIonosName,
    getIonosModel,
    describeIonosModel,
    normalizeReasoningEffort,
    clampMaxTokens,
    ionosPricingKey,
    getIonosListPrice,
    registerIonosModel,
    isIonosServedModel,
    _resetIonosModelRegistry,
};
