// @typecheck
/**
 * Scaleway Generative APIs — serverless model catalog + served-model registry.
 *
 * Scaleway's Generative APIs are OpenAI-compatible serverless endpoints for
 * open-weight models, hosted in EU data centres (Paris / Amsterdam) and billed
 * per 1M tokens. That combination — open weights, EU-only inference, no
 * per-customer training — is why this provider matters for a GDPR product, so
 * it gets a real catalog instead of the generic OpenAI-compatible fallback.
 *
 * Three jobs, deliberately in one dependency-free module (same reasoning as
 * ./localModels.js — it is required from adapters, cost accounting and route
 * handlers, so it must not pull in anything that could cycle):
 *
 *  1. CATALOG — id → display name, category, context window, max output and
 *     capability flags. `/v1/models` hands back bare ids and nothing else, so
 *     without this a Scaleway model would land in the tier picker as a raw
 *     string with no idea whether it can see images or call tools.
 *
 *  2. REQUEST SHAPING FACTS — per-model `reasoning_effort` vocabularies and
 *     output caps. Scaleway rejects an unsupported effort value and an over-cap
 *     `max_tokens` with a 400, so the adapter needs to know both before it
 *     builds a body.
 *
 *  3. SERVED-MODEL REGISTRY — which model ids are currently served by a
 *     Scaleway provider. Cost accounting reads this. Every model here is
 *     open-weight and therefore also sold by half a dozen other hosts at
 *     different prices, so modelCosts' fuzzy "ends with /<id>" match would
 *     happily bill a Scaleway `gpt-oss-120b` call at another host's rate. The
 *     registry lets cost lookup pin the price to Scaleway's own tariff.
 *     Populated by the adapter on listModels() and by getProviderForModel() on
 *     every resolution, so it is warm before any cost is computed.
 *
 * Catalog data verified 2026-08-15 against the Scaleway console (Generative
 * APIs → Models, Serverless filter) and
 * https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/
 */

// Default serverless endpoint. A Scaleway Project can also be pinned with
// https://api.scaleway.ai/<project-id>/v1 — both shapes are accepted anywhere
// a base URL is taken, so admins can scope a key to one project.
const SCALEWAY_BASE_URL = 'https://api.scaleway.ai/v1';

// Reasoning models default to reasoning ON. `none` turns it off on every
// reasoning model EXCEPT gpt-oss-120b, which has no off switch. Values outside
// a model's vocabulary are a 400, so the adapter drops rather than forwards an
// unsupported one — see normalizeReasoningEffort.
const EFFORT_STANDARD = Object.freeze(['none', 'low', 'medium', 'high']);
const EFFORT_NO_OFF = Object.freeze(['low', 'medium', 'high']);
const EFFORT_GLM = Object.freeze(['none', 'high', 'max']);

/**
 * The catalog.
 *
 * `serverless: true` marks the models Generative APIs serves on demand — the
 * set this provider is about. The handful of `serverless: false` entries are
 * models Scaleway only offers on Dedicated Deployments; they are here so that
 * an admin who points this adapter at a dedicated endpoint still gets proper
 * metadata instead of a bare id.
 *
 * `org` is the vendor segment the community pricing database uses in its
 * `scaleway/<org>/<id>` keys — case-sensitive, hence `BAAI`.
 *
 * `price` is Scaleway's published list price per 1M tokens (EUR), used only as
 * a fallback for models the community pricing database has not picked up yet.
 */
const SCALEWAY_MODELS = {
    // ── Reasoning ────────────────────────────────────────────────────────────
    'glm-5.2': {
        org: 'zai', name: 'GLM-5.2', cat: 'Reasoning',
        desc: 'Frontier reasoning and coding model for long-horizon agentic tasks',
        context: 256_000, maxOutput: 16_384,
        reasoning: true, tools: true, effort: EFFORT_GLM,
        serverless: true, status: 'preview',
        price: { input: 1.80, output: 5.50 },
    },
    'deepseek-v4-flash-0731': {
        org: 'deepseek', name: 'DeepSeek V4 Flash', cat: 'Reasoning',
        desc: 'Cost-efficient reasoning and coding model with cached-input pricing',
        context: 256_000, maxOutput: 32_768,
        reasoning: true, tools: true, effort: EFFORT_STANDARD,
        serverless: true, status: 'preview',
        price: { input: 0.40, output: 0.80, cacheRead: 0.08 },
    },
    'qwen3.5-397b-a17b': {
        org: 'qwen', name: 'Qwen3.5 397B A17B', cat: 'Reasoning',
        desc: 'Frontier MoE model for agentic coding and image analysis',
        context: 250_000, maxOutput: 16_384,
        reasoning: true, vision: true, tools: true, effort: EFFORT_STANDARD,
        serverless: true,
        price: { input: 0.60, output: 3.60 },
    },
    'qwen3.6-35b-a3b': {
        org: 'qwen', name: 'Qwen3.6 35B A3B', cat: 'Reasoning',
        desc: 'Compact MoE model for agentic tasks, structured output and tools',
        context: 256_000, maxOutput: 32_768,
        reasoning: true, vision: true, tools: true, effort: EFFORT_STANDARD,
        serverless: true,
        price: { input: 0.25, output: 1.50 },
    },
    'gemma-4-26b-a4b-it': {
        org: 'google', name: 'Gemma 4 26B A4B', cat: 'Reasoning',
        desc: 'Google MoE model for agentic reasoning and image analysis',
        context: 256_000, maxOutput: 32_768,
        reasoning: true, vision: true, tools: true, effort: EFFORT_STANDARD,
        serverless: true, status: 'preview',
        price: { input: 0.25, output: 0.50 },
    },
    'gpt-oss-120b': {
        org: 'openai', name: 'GPT-OSS 120B', cat: 'Reasoning',
        desc: 'OpenAI open-weight reasoning model with high throughput',
        context: 128_000, maxOutput: 32_768,
        // The one reasoning model with no off switch — `none` is rejected.
        reasoning: true, tools: true, effort: EFFORT_NO_OFF,
        serverless: true,
        price: { input: 0.15, output: 0.60 },
    },

    // ── Generalist ───────────────────────────────────────────────────────────
    'mistral-medium-3.5-128b': {
        org: 'mistralai', name: 'Mistral Medium 3.5', cat: 'Generalist',
        desc: 'Mistral unified reasoning and coding model with vision',
        context: 180_000, maxOutput: 16_384,
        reasoning: true, vision: true, tools: true, effort: EFFORT_STANDARD,
        serverless: true, status: 'preview',
        price: { input: 1.50, output: 7.50 },
    },
    'mistral-small-3.2-24b-instruct-2506': {
        org: 'mistralai', name: 'Mistral Small 3.2 24B', cat: 'Generalist',
        desc: 'Dense 24B model with improved tool-calling and vision',
        context: 128_000, maxOutput: 32_768,
        vision: true, tools: true,
        serverless: true,
        price: { input: 0.15, output: 0.35 },
    },
    'qwen3-235b-a22b-instruct-2507': {
        org: 'qwen', name: 'Qwen3 235B A22B Instruct', cat: 'Generalist',
        desc: 'Large multilingual instruct model',
        context: 250_000, maxOutput: 16_384,
        tools: true,
        serverless: true,
        price: { input: 0.75, output: 2.25 },
    },
    'llama-3.3-70b-instruct': {
        org: 'meta', name: 'Llama 3.3 70B Instruct', cat: 'Generalist',
        desc: 'Meta instruct model — note: no parallel tool calls',
        // 100k on serverless; dedicated deployments go to 128k.
        context: 100_000, maxOutput: 16_384,
        tools: true, parallelToolCalls: false,
        serverless: true,
        price: { input: 0.90, output: 0.90 },
    },

    // ── Coding ───────────────────────────────────────────────────────────────
    'qwen3-coder-30b-a3b-instruct': {
        org: 'qwen', name: 'Qwen3 Coder 30B A3B', cat: 'Coding',
        desc: 'Code completion and editing model',
        context: 128_000, maxOutput: 32_768,
        tools: true,
        serverless: true, status: 'deprecated',
        price: { input: 0.20, output: 0.80 },
    },

    // ── Vision ───────────────────────────────────────────────────────────────
    'pixtral-12b-2409': {
        org: 'mistralai', name: 'Pixtral 12B', cat: 'Vision',
        desc: 'Vision language model, up to 12 images per request',
        context: 128_000, maxOutput: 4_096,
        vision: true, tools: true,
        serverless: true, status: 'deprecated',
        price: { input: 0.20, output: 0.20 },
    },

    // ── Audio ────────────────────────────────────────────────────────────────
    // Transcription-only: served on /v1/audio/transcriptions, not on
    // /v1/chat/completions. Listed so it is recognisable in admin surfaces, but
    // excluded from the chat model list — see listChatModels().
    'whisper-large-v3': {
        org: 'openai', name: 'Whisper Large v3', cat: 'Audio',
        desc: 'Speech-to-text for 87+ languages (transcription endpoint only)',
        audio: true,
        serverless: true, status: 'preview',
        // Billed per audio minute, not per token — no per-token rate applies.
        price: null,
    },

    // ── Embeddings ───────────────────────────────────────────────────────────
    'qwen3-embedding-8b': {
        org: 'qwen', name: 'Qwen3 Embedding 8B', cat: 'Embedding',
        desc: 'Matryoshka embeddings (32–4096 dims), 119+ languages',
        context: 32_000,
        embedding: true,
        serverless: true,
        price: { input: 0.10, output: 0 },
    },
    'bge-multilingual-gemma2': {
        org: 'BAAI', name: 'BGE Multilingual Gemma2', cat: 'Embedding',
        desc: 'Multilingual embedding model (3584 dims)',
        context: 8_000,
        embedding: true,
        serverless: true,
        price: { input: 0.10, output: 0 },
    },

    // ── Dedicated-deployment only ────────────────────────────────────────────
    // Not served by Generative APIs on demand. Present so an adapter pointed at
    // a dedicated endpoint still describes them properly.
    'gemma-3-27b-it': {
        org: 'google', name: 'Gemma 3 27B', cat: 'Vision',
        desc: 'Multilingual text and image analysis',
        context: 40_000, maxOutput: 8_192,
        vision: true, tools: true,
        serverless: false,
        price: { input: 0.25, output: 0.50 },
    },
    'devstral-2-123b-instruct-2512': {
        org: 'mistralai', name: 'Devstral 2 123B', cat: 'Coding',
        desc: 'Software-engineering agent model',
        context: 200_000, maxOutput: 16_384,
        tools: true,
        serverless: false,
        price: { input: 0.40, output: 2.00 },
    },
    'voxtral-small-24b-2507': {
        org: 'mistralai', name: 'Voxtral Small 24B', cat: 'Audio',
        desc: 'Audio understanding and transcription, 8 languages',
        context: 32_000, maxOutput: 16_384,
        audio: true, tools: true,
        serverless: false,
        price: { input: 0.15, output: 0.35 },
    },
    'holo2-30b-a3b': {
        org: 'hcompany', name: 'Holo2 30B A3B', cat: 'Vision',
        desc: 'GUI analysis model — does not support function calling',
        context: 22_000, maxOutput: 16_384,
        reasoning: true, vision: true, effort: EFFORT_STANDARD,
        serverless: false,
        price: { input: 0.30, output: 0.70 },
    },
};

const CATALOG_IDS = Object.freeze(Object.keys(SCALEWAY_MODELS));

/**
 * Strip a vendor segment from a model id.
 *
 * Scaleway's own ids are bare (`qwen3.6-35b-a3b`) but routing layers and the
 * community pricing database write them vendor-qualified (`qwen/qwen3.6-35b-a3b`),
 * and an admin copying an id out of one of those would otherwise get an
 * unrecognised model. Only the lookup key is normalised — the raw id keeps
 * going over the wire untouched.
 */
function normalizeScalewayModelId(modelId) {
    if (!modelId || typeof modelId !== 'string') return '';
    const id = modelId.trim();
    const slash = id.lastIndexOf('/');
    return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
}

/** Raw catalog entry for an id, or null when it is not a model we know. */
function getScalewayModel(modelId) {
    return SCALEWAY_MODELS[normalizeScalewayModelId(modelId)] || null;
}

/**
 * Describe a Scaleway model: display name, category, capabilities, limits.
 * Always returns an object — an id Scaleway added after this catalog was
 * written still gets sensible values from the open-weight family patterns in
 * ./localModels.js, which already know the Qwen / Gemma / Mistral / gpt-oss /
 * GLM families these are drawn from.
 *
 * @returns {{id, name, cat, desc, context, maxOutput, reasoning, vision, tools,
 *            embedding, audio, status, scaleway: true}}
 */
function describeScalewayModel(modelId) {
    const entry = getScalewayModel(modelId);
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
            audio: !!entry.audio,
            status: entry.status || 'ga',
            scaleway: true,
        };
    }

    // Unknown id — fall back to the shared open-weight family guess. It is the
    // same knowledge the self-hosted runtimes rely on, and these are the same
    // weights, so a model Scaleway adds tomorrow still sorts into the right
    // tier-picker group instead of showing up as an unlabelled string.
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
        audio: false,
        status: 'ga',
        scaleway: true,
    };
}

/** The serverless catalog, described — used for admin surfaces and tests. */
function listServerlessModels() {
    return CATALOG_IDS
        .filter(id => SCALEWAY_MODELS[id].serverless)
        .map(id => describeScalewayModel(id));
}

/**
 * Coerce a requested reasoning effort into something this model accepts.
 *
 * Scaleway answers an unsupported value with a 400 that fails the whole
 * request, and the vocabulary genuinely differs per model: gpt-oss-120b has no
 * `none`, GLM-5.2 speaks `high`/`max`. Dropping an unsupported value leaves the
 * model at its default effort, which is always a working request — the
 * alternative is a hard failure on, for example, title generation, which asks
 * every provider for `none`.
 *
 * @returns {string|null} the value to send, or null to omit the parameter
 */
function normalizeReasoningEffort(modelId, requested) {
    if (!requested) return null;
    const entry = getScalewayModel(modelId);
    // Unknown model: only forward the values every Scaleway reasoning model
    // understands. Guessing wider risks a 400 on a model we have never seen.
    const allowed = entry ? entry.effort : EFFORT_STANDARD;
    if (!allowed) return null;                       // not a reasoning model
    return allowed.includes(requested) ? requested : null;
}

/**
 * Cap an output-token request at what the model actually allows.
 * Serverless caps are much lower than the context window (16k–32k), and asking
 * for more is a 400 rather than a silent truncation.
 *
 * @returns {number|undefined} the value to send, or undefined to omit it
 */
function clampMaxTokens(modelId, requested) {
    const n = Number(requested);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const cap = getScalewayModel(modelId)?.maxOutput;
    return cap ? Math.min(n, cap) : n;
}

/**
 * The community pricing database's key for a model (`scaleway/<org>/<id>`), or
 * null for an id outside the catalog. Cost accounting looks this up EXACTLY —
 * never fuzzily — because every model here is open-weight and also sold by
 * other hosts at other prices.
 */
function scalewayPricingKey(modelId) {
    const id = normalizeScalewayModelId(modelId);
    const entry = SCALEWAY_MODELS[id];
    return entry ? `scaleway/${entry.org}/${id}` : null;
}

/**
 * Scaleway's published list price per 1M tokens, as a last resort for models
 * the community pricing database has not picked up yet (new preview models
 * land in the console before they land there).
 *
 * @returns {{input, output, cacheRead}|null}
 */
function getScalewayListPrice(modelId) {
    const price = getScalewayModel(modelId)?.price;
    if (!price) return null;
    return {
        input: price.input,
        output: price.output,
        cacheRead: price.cacheRead ?? 0,
    };
}

// ─── Served-model registry (pins cost accounting to Scaleway's tariff) ───────
// Bounded exactly like the local-model registry: the ids that matter are
// re-registered on every resolution, so insertion-order eviction is safe.
const MAX_REGISTERED = 1000;
const _scalewayModelIds = new Set();

/** Record that `modelId` is currently served by a Scaleway provider. */
function registerScalewayModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return;
    if (_scalewayModelIds.has(modelId)) return;
    if (_scalewayModelIds.size >= MAX_REGISTERED) {
        const oldest = _scalewayModelIds.values().next().value;
        _scalewayModelIds.delete(oldest);
    }
    _scalewayModelIds.add(modelId);
}

/** True when the model is known to be served by a Scaleway provider. */
function isScalewayServedModel(modelId) {
    return !!modelId && _scalewayModelIds.has(modelId);
}

/** Test seam — drops every registration. */
function _resetScalewayModelRegistry() {
    _scalewayModelIds.clear();
}

module.exports = {
    SCALEWAY_BASE_URL,
    SCALEWAY_MODELS,
    normalizeScalewayModelId,
    getScalewayModel,
    describeScalewayModel,
    listServerlessModels,
    normalizeReasoningEffort,
    clampMaxTokens,
    scalewayPricingKey,
    getScalewayListPrice,
    registerScalewayModel,
    isScalewayServedModel,
    _resetScalewayModelRegistry,
};
