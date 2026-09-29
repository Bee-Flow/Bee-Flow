// @typecheck
/**
 * Mistral AI (La Plateforme) — model catalog, request-shaping facts and the
 * served-model registries cost accounting reads.
 *
 * Same three jobs as ./scalewayModels.js, and dependency-free for the same
 * reason (required from the adapter, cost accounting and the resolver):
 *
 *  1. CATALOG — id → display name, category, context window and capability
 *     flags, matched by family pattern because Mistral ships a pinned id per
 *     release (`mistral-small-2603`) plus moving aliases (`mistral-small-latest`,
 *     `mistral-small-4`). The live `/v1/models` list DOES carry capability flags;
 *     the adapter remembers those per id (rememberMistralCapabilities) and they
 *     win over the patterns here, which only have to be right for ids the live
 *     list has not described yet.
 *
 *  2. REQUEST SHAPING — the `reasoning_effort` vocabulary per model. Reasoning
 *     on Mistral is no longer a separate model family (Magistral is retired):
 *     it is a switch on Mistral Small 4 and Medium 3.5, and the documented
 *     values are `none` and `high` only. The stack asks for anything from
 *     `none` to `max`, so the value is mapped onto the model's vocabulary
 *     instead of being forwarded blindly.
 *
 *  3. REGISTRIES — which ids a Mistral provider actually serves, and which of
 *     those it serves from a regional endpoint. Ministral and Mistral Small are
 *     open weights that other hosts sell too, so modelCosts' fuzzy price match
 *     could bill a Mistral call at another host's rate; the served registry
 *     pins it to Mistral's own price. The regional endpoints (api.eu / api.us)
 *     cost 1.1× the list price, and cost accounting runs far from the provider
 *     record — the same reason the EU registry in ./openaiModels.js exists.
 *
 * Prices are USD per 1M tokens from https://docs.mistral.ai/inference/pricing
 * (checked 2026-09-26). Cached input is billed at 10% of the input rate on
 * every current model (https://docs.mistral.ai/studio/conversations/advanced/prompt-caching).
 *
 * NOT verified against the live API yet (no key on the dev stack when this was
 * written): whether values other than `none`/`high` are accepted. That only
 * affects the EFFORT lists below: widen them there, the mapping follows. (The
 * adapter always sends an effort to a model with the switch, so the model's
 * own default never decides.)
 */

const MISTRAL_DEFAULT_SERVER_URL = 'https://api.mistral.ai';

// Regional-processing endpoints are billed at 1.1× the list price, cached
// reads included (https://docs.mistral.ai/inference/regional-inference).
const MISTRAL_REGIONAL_UPLIFT = 1.1;

// The two documented values. `none` is a real request (reasoning off), not an
// omission — title generation and the classifier rely on it.
const EFFORT_BINARY = Object.freeze(['none', 'high']);

// Rank of every effort value the stack emits, cheapest first. Used to map a
// requested value onto the nearest one a model accepts.
const EFFORT_RANK = Object.freeze({ none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 });

/**
 * @typedef {{ input: number, cachedInput: number, output: number }} MistralPrice
 * @typedef {{
 *   match: RegExp, name: string, cat: string, context?: number,
 *   vision?: boolean, tools?: boolean, reasoning?: boolean,
 *   efforts?: ReadonlyArray<string>|null, legacy?: boolean,
 *   price?: MistralPrice|null,
 * }} MistralFamily
 */

/**
 * Family patterns, most specific first — the first match wins. Pinned ids of
 * retired generations come before the family default, which describes the
 * model the `-latest` alias currently points to.
 *
 * `legacy: true` marks generations Mistral has retired; their pinned ids 404.
 * They stay here so an old tier config still shows a proper name and so the
 * price of a call made before retirement can be looked up.
 *
 * @type {ReadonlyArray<MistralFamily>}
 */
const MISTRAL_FAMILIES = Object.freeze([
    // ── Generalist ───────────────────────────────────────────────────────────
    {
        match: /^mistral-medium-(2505|2508)$/, name: 'Mistral Medium 3.1', cat: 'Generalist',
        context: 128_000, vision: true, tools: true, legacy: true,
        price: { input: 0.4, cachedInput: 0.04, output: 2 },
    },
    {
        match: /^mistral-medium/, name: 'Mistral Medium 3.5', cat: 'Generalist',
        context: 256_000, vision: true, tools: true, reasoning: true, efforts: EFFORT_BINARY,
        price: { input: 1.5, cachedInput: 0.15, output: 7.5 },
    },
    {
        match: /^mistral-small-(2402|2409|2501|2503|2506)$/, name: 'Mistral Small 3.2', cat: 'Generalist',
        context: 128_000, vision: true, tools: true, legacy: true,
        price: { input: 0.1, cachedInput: 0.01, output: 0.3 },
    },
    {
        match: /^mistral-small/, name: 'Mistral Small 4', cat: 'Generalist',
        context: 256_000, vision: true, tools: true, reasoning: true, efforts: EFFORT_BINARY,
        price: { input: 0.15, cachedInput: 0.015, output: 0.6 },
    },
    {
        match: /^mistral-large-(2402|2407|2411)$/, name: 'Mistral Large 2', cat: 'Generalist',
        context: 128_000, tools: true, legacy: true,
        price: { input: 2, cachedInput: 0.2, output: 6 },
    },
    {
        match: /^mistral-large/, name: 'Mistral Large 3', cat: 'Generalist',
        context: 256_000, vision: true, tools: true,
        price: { input: 0.5, cachedInput: 0.05, output: 1.5 },
    },
    {
        match: /^ministral-8b-2410$/, name: 'Ministral 8B', cat: 'Generalist',
        context: 128_000, tools: true, legacy: true,
        price: { input: 0.1, cachedInput: 0.01, output: 0.1 },
    },
    {
        match: /^ministral-3b-2410$/, name: 'Ministral 3B', cat: 'Generalist',
        context: 128_000, tools: true, legacy: true,
        price: { input: 0.04, cachedInput: 0.004, output: 0.04 },
    },
    {
        match: /^ministral-14b/, name: 'Ministral 3 14B', cat: 'Generalist',
        context: 256_000, vision: true, tools: true,
        price: { input: 0.2, cachedInput: 0.02, output: 0.2 },
    },
    {
        match: /^ministral-8b/, name: 'Ministral 3 8B', cat: 'Generalist',
        context: 256_000, vision: true, tools: true,
        price: { input: 0.15, cachedInput: 0.015, output: 0.15 },
    },
    {
        match: /^ministral-3b/, name: 'Ministral 3 3B', cat: 'Generalist',
        context: 256_000, vision: true, tools: true,
        price: { input: 0.1, cachedInput: 0.01, output: 0.1 },
    },
    {
        match: /^(open-)?mistral-nemo/, name: 'Mistral Nemo', cat: 'Generalist',
        context: 128_000, tools: true, legacy: true,
        price: { input: 0.15, cachedInput: 0.015, output: 0.15 },
    },

    // ── Embeddings (listed before Coding: `codestral-embed` is not a coder) ──
    {
        match: /^(mistral|codestral)-embed/, name: 'Mistral Embed', cat: 'Embedding',
        context: 8_000,
        price: { input: 0.1, cachedInput: 0.1, output: 0 },
    },

    // ── Coding ───────────────────────────────────────────────────────────────
    {
        match: /^codestral/, name: 'Codestral', cat: 'Coding',
        context: 128_000, tools: true,
        price: { input: 0.3, cachedInput: 0.03, output: 0.9 },
    },
    {
        match: /^devstral/, name: 'Devstral', cat: 'Coding',
        context: 256_000, tools: true, legacy: true,
        price: { input: 0.4, cachedInput: 0.04, output: 2 },
    },

    // ── Retired reasoning / vision families ──────────────────────────────────
    // Magistral always reasoned (the thinking came back as chunks whatever was
    // asked), so it takes no effort value — `efforts: null`.
    {
        match: /^magistral-medium/, name: 'Magistral Medium', cat: 'Reasoning',
        context: 128_000, tools: true, reasoning: true, efforts: null, legacy: true,
        price: { input: 2, cachedInput: 0.2, output: 5 },
    },
    {
        match: /^magistral/, name: 'Magistral Small', cat: 'Reasoning',
        context: 128_000, tools: true, reasoning: true, efforts: null, legacy: true,
        price: { input: 0.5, cachedInput: 0.05, output: 1.5 },
    },
    {
        match: /^pixtral-large/, name: 'Pixtral Large', cat: 'Vision',
        context: 128_000, vision: true, tools: true, legacy: true,
        price: { input: 2, cachedInput: 0.2, output: 6 },
    },
    {
        match: /^pixtral/, name: 'Pixtral 12B', cat: 'Vision',
        context: 128_000, vision: true, tools: true, legacy: true,
        price: { input: 0.15, cachedInput: 0.015, output: 0.15 },
    },

    // ── Not chat models — categorised so the tier picker leaves them out ─────
    // OCR and audio are billed per page / per minute, not per token.
    { match: /^mistral-ocr/, name: 'Mistral OCR', cat: 'OCR', price: null },
    { match: /^mistral-moderation/, name: 'Mistral Moderation', cat: 'Moderation', price: { input: 0, cachedInput: 0, output: 0 } },
    { match: /^voxtral/, name: 'Voxtral', cat: 'Audio', price: null },
]);

/** Lookup key: lower-case, vendor prefix (`mistral/`, `mistralai/`) removed. */
function normalizeMistralModelId(modelId) {
    if (!modelId || typeof modelId !== 'string') return '';
    const id = modelId.trim().toLowerCase();
    const slash = id.lastIndexOf('/');
    return slash >= 0 ? id.slice(slash + 1) : id;
}

/** @returns {MistralFamily|null} */
function getMistralFamily(modelId) {
    const id = normalizeMistralModelId(modelId);
    if (!id) return null;
    return MISTRAL_FAMILIES.find(f => f.match.test(id)) || null;
}

// ─── Live capabilities (from /v1/models) ─────────────────────────────────────
// The API's own flags for each id it listed. They beat the patterns above:
// Mistral re-points aliases and adds models faster than this file changes.
// Bounded like the registries below; every listModels() call refreshes it.
const MAX_REMEMBERED = 1000;
/** @type {Map<string, { vision?: boolean, tools?: boolean, reasoning?: boolean, context?: number }>} */
const _liveCapabilities = new Map();

/**
 * Remember what `/v1/models` said about an id.
 * @param {string} modelId
 * @param {{ vision?: boolean, tools?: boolean, reasoning?: boolean, context?: number }} caps
 */
function rememberMistralCapabilities(modelId, caps) {
    const id = normalizeMistralModelId(modelId);
    if (!id || !caps) return;
    if (!_liveCapabilities.has(id) && _liveCapabilities.size >= MAX_REMEMBERED) {
        const oldest = _liveCapabilities.keys().next().value;
        if (oldest !== undefined) _liveCapabilities.delete(oldest);
    }
    _liveCapabilities.set(id, caps);
}

/**
 * Describe a Mistral model. Always returns an object: an id this file has
 * never seen gets conservative defaults (tools yes, vision and reasoning no),
 * overridden by whatever the live model list reported for it.
 *
 * @returns {{ id: string, name: string, cat: string, context: number|null,
 *   vision: boolean, tools: boolean, reasoning: boolean,
 *   efforts: ReadonlyArray<string>|null, legacy: boolean }}
 */
function describeMistralModel(modelId) {
    const family = getMistralFamily(modelId);
    const live = _liveCapabilities.get(normalizeMistralModelId(modelId));
    const reasoning = live?.reasoning ?? !!family?.reasoning;
    // A model the live list calls reasoning-capable but this file does not know
    // gets the documented vocabulary rather than none at all.
    const efforts = family && family.efforts !== undefined
        ? family.efforts
        : (reasoning ? EFFORT_BINARY : null);
    return {
        id: modelId,
        name: family?.name || modelId,
        cat: family?.cat || 'Generalist',
        context: live?.context ?? family?.context ?? null,
        vision: live?.vision ?? !!family?.vision,
        tools: live?.tools ?? (family ? !!family.tools : true),
        reasoning,
        efforts: reasoning ? efforts : null,
        legacy: !!family?.legacy,
    };
}

/**
 * The effort to send for a requested one, mapped onto the model's vocabulary.
 *
 * The nearest accepted value wins, and a tie goes to the cheaper one. With the
 * documented `none`/`high` that reads: none|minimal|low → none, and
 * medium|high|xhigh|max → high. So the standard tier (`low`) stays fast and
 * the thinking tiers (`medium`, `high`) reason.
 *
 * @returns {string|undefined} the value to send, or undefined to omit it — for
 *   a model without a switch, or when nothing was asked (the model's default)
 */
function normalizeMistralEffort(modelId, requested) {
    if (!requested || typeof requested !== 'string') return undefined;
    const { efforts } = describeMistralModel(modelId);
    if (!efforts || efforts.length === 0) return undefined;
    if (efforts.includes(requested)) return requested;
    const want = EFFORT_RANK[requested];
    if (want === undefined) return undefined;
    let best;
    let bestDistance = Infinity;
    for (const value of efforts) {
        const rank = EFFORT_RANK[value];
        if (rank === undefined) continue;
        const distance = Math.abs(rank - want);
        // Strictly closer wins; on a tie the earlier (cheaper) value stays.
        if (distance < bestDistance) {
            best = value;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * The cheapest effort for a speed tier (fast/swarm) on a Mistral model, or
 * null when the model has no switch.
 *
 * The generic rule elsewhere skips `none` ("the fast tier wants speed, not
 * reasoning switched off"), but that rule assumes a cheap reasoning level
 * exists. With only `none` and `high` there is none: the cheapest level that
 * still reasons is the most expensive one there is. A speed tier gets `none`.
 */
function cheapestMistralEffort(modelId) {
    const { efforts } = describeMistralModel(modelId);
    if (!efforts || efforts.length === 0) return null;
    const reasoningLevels = efforts.filter(e => e !== 'none');
    const hasCheapLevel = reasoningLevels.some(e => (EFFORT_RANK[e] ?? 99) <= EFFORT_RANK.low);
    if (hasCheapLevel) return reasoningLevels[0];
    return efforts.includes('none') ? 'none' : (reasoningLevels[0] || null);
}

/**
 * The community pricing database's key (`mistral/<id>`). Looked up EXACTLY,
 * never fuzzily — see the served registry below.
 */
function mistralPricingKey(modelId) {
    const id = normalizeMistralModelId(modelId);
    return id ? `mistral/${id}` : null;
}

/**
 * Mistral's published list price per 1M tokens (USD), or null for ids billed
 * per page/minute or unknown to this file.
 * @returns {{ input: number, output: number, cacheRead: number }|null}
 */
function getMistralListPrice(modelId) {
    const price = getMistralFamily(modelId)?.price;
    if (!price) return null;
    return { input: price.input, output: price.output, cacheRead: price.cachedInput };
}

/**
 * Cached-read price as a fraction of the input price, or null when unknown.
 * 0.1 on every current model.
 */
function mistralCacheReadRatio(modelId) {
    const price = getMistralFamily(modelId)?.price;
    if (!price || !(price.input > 0)) return null;
    return price.cachedInput / price.input;
}

// ─── Served-model registries ─────────────────────────────────────────────────
// Bounded like the Scaleway and local registries: the ids that matter are
// re-registered on every resolution, so insertion-order eviction is safe.
const MAX_REGISTERED = 1000;
const _servedIds = new Set();
const _regionalIds = new Set();

function _bounded(set, id) {
    if (set.has(id)) return;
    if (set.size >= MAX_REGISTERED) {
        const oldest = set.values().next().value;
        set.delete(oldest);
    }
    set.add(id);
}

/** Record that `modelId` is served by a Mistral provider. */
function registerMistralModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return;
    _bounded(_servedIds, modelId);
}

/** True when the model is known to be served by a Mistral provider. */
function isMistralServedModel(modelId) {
    return !!modelId && _servedIds.has(modelId);
}

/**
 * True for Mistral's regional-processing hosts (api.eu.mistral.ai,
 * api.us.mistral.ai). The default api.mistral.ai is not regional.
 */
function isMistralRegionalUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const host = new URL(url).hostname.toLowerCase();
        return /^api\.[a-z]{2}\.mistral\.ai$/.test(host);
    } catch (_) {
        return false;
    }
}

/** Record whether a served model is answered by a regional endpoint. */
function setMistralRegionalModel(modelId, regional) {
    if (!modelId || typeof modelId !== 'string') return;
    if (regional) _bounded(_regionalIds, modelId);
    else _regionalIds.delete(modelId);
}

/** Multiplier cost accounting applies to a Mistral call. */
function mistralRegionalUplift(modelId) {
    return modelId && _regionalIds.has(modelId) ? MISTRAL_REGIONAL_UPLIFT : 1;
}

/** Test seam — drops every registration and remembered capability. */
function _resetMistralRegistries() {
    _servedIds.clear();
    _regionalIds.clear();
    _liveCapabilities.clear();
}

module.exports = {
    MISTRAL_DEFAULT_SERVER_URL,
    MISTRAL_REGIONAL_UPLIFT,
    MISTRAL_FAMILIES,
    EFFORT_BINARY,
    normalizeMistralModelId,
    describeMistralModel,
    rememberMistralCapabilities,
    normalizeMistralEffort,
    cheapestMistralEffort,
    mistralPricingKey,
    getMistralListPrice,
    mistralCacheReadRatio,
    registerMistralModel,
    isMistralServedModel,
    isMistralRegionalUrl,
    setMistralRegionalModel,
    mistralRegionalUplift,
    _resetMistralRegistries,
};
