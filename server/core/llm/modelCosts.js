// @typecheck
/**
 * Model Cost Registry — AI model pricing
 * 
 * Pricing sources (in priority order):
 * 1. Custom admin overrides (persisted via configStore)
 * 2. Self-hosted models (Ollama / vLLM / llama.cpp / …) — always €0
 * 3. Scaleway-served models — Scaleway's own tariff, never another host's rate
 *    for the same open weights
 * 4. Mistral-served models — Mistral's own list price, same reason
 * 5. Community pricing database (2600+ models, fetched from GitHub, 24h cache)
 *
 * Prices are in USD per 1 million tokens.
 */

const configStore = require('../../stores/configStore');
const { getModelPricing, getPricingByKey, initPricing } = require('./pricingService');
const { isLocalModel } = require('../providers/localModels');
const {
    isScalewayServedModel,
    scalewayPricingKey,
    getScalewayListPrice,
} = require('../providers/scalewayModels');
const {
    isMistralServedModel,
    mistralPricingKey,
    getMistralListPrice,
    mistralCacheReadRatio,
    mistralRegionalUplift,
} = require('../providers/mistralModels');
const log = require('../../telemetry/log');

// Self-hosted inference has no per-token price. The rates below are the
// canonical "free" answer for a model the customer runs on their own hardware.
const LOCAL_MODEL_RATES = Object.freeze({ input: 0, output: 0, cacheRead: 0 });

// Initialize pricing data on startup (non-blocking)
initPricing();

// ─── Custom Overrides (admin-edited via AI Config) ───────────────────────────
//
// The overrides live in configStore, which is async; the lookups below are
// synchronous and sit on every LLM call's cost path. So reads go through a
// process-local snapshot: loaded on first use, then refreshed from the store at
// most every OVERRIDES_TTL_MS, which is how a save on another replica arrives
// here. Writes go through configStore.mutateConfig — an atomic read-modify-write
// across replicas — one at a time, in the order they were made.
//
// This used to call configStore.getConfig synchronously. It JSON-parsed the
// Promise that came back, threw, and fell back to {} — so no override was ever
// applied, and every save started from {} and wrote only its own model, wiping
// the others.

const CONFIG_KEY = 'model_cost_overrides';
const OVERRIDES_TTL_MS = 60_000;

let _overrides = {};
let _overridesLoadedAt = 0;
let _overridesLoading = null;
let _writes = Promise.resolve();

/** Stored as an object; rows written by the old code hold the same JSON as text. */
function _asOverrides(raw) {
    let value = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { value = null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Re-read the overrides from the store. A failed read keeps the last good
 * snapshot: falling back to {} would quietly bill at list price again.
 */
function refreshCustomOverrides() {
    if (_overridesLoading) return _overridesLoading;
    _overridesLoading = Promise.resolve()
        .then(() => configStore.getConfig(CONFIG_KEY))
        .then((raw) => {
            _overrides = _asOverrides(raw);
            _overridesLoadedAt = Date.now();
            resetUpperBoundCache();
        })
        .catch((e) => { log.warn(`[ModelCosts] could not read the cost overrides: ${e.message}`); })
        .finally(() => { _overridesLoading = null; });
    return _overridesLoading;
}

function getCustomOverrides() {
    if (Date.now() - _overridesLoadedAt > OVERRIDES_TTL_MS) refreshCustomOverrides();
    return _overrides;
}

/** One write at a time: a caller that loops without awaiting loses nothing. */
function _mutateOverrides(change) {
    const run = _writes.then(async () => {
        const next = await configStore.mutateConfig(CONFIG_KEY, (current) => change({ ..._asOverrides(current) }));
        _overrides = _asOverrides(next);
        _overridesLoadedAt = Date.now();
        resetUpperBoundCache();
    });
    _writes = run.catch((e) => { log.error(`[ModelCosts] could not save a cost override: ${e.message}`); });
    return run;
}

/**
 * Set a custom cost for a model (admin override).
 */
function setModelCost(modelId, input, output) {
    return _mutateOverrides((overrides) => {
        overrides[modelId] = { input: Number(input), output: Number(output) };
        return overrides;
    });
}

/**
 * Remove custom cost override for a model (revert to default pricing).
 */
function resetModelCost(modelId) {
    return _mutateOverrides((overrides) => {
        delete overrides[modelId];
        return overrides;
    });
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

// Memoised upper-bound rates (most-expensive across all known models). Used
// as a safe fallback for unknown models so customers calling a brand-new
// model name aren't billed €0 until LiteLLM data lands. Re-computed lazily
// once per process; cleared via `resetUpperBoundCache` (admin custom-override
// edits invalidate it so a newly-added high-cost override is picked up).
let _upperBoundCache = null;
let _upperBoundComputedAt = 0;
const _unknownModelWarned = new Set();

function _computeUpperBound() {
    try {
        const all = getAllModelCosts(); // { name: { input, output } } including custom overrides
        let maxInput = 0;
        let maxOutput = 0;
        for (const rates of Object.values(all)) {
            if (Number.isFinite(rates?.input) && rates.input > maxInput) maxInput = rates.input;
            if (Number.isFinite(rates?.output) && rates.output > maxOutput) maxOutput = rates.output;
        }
        if (maxInput <= 0 && maxOutput <= 0) return null;
        return { input: maxInput, output: maxOutput };
    } catch (_) { return null; }
}

function _getUpperBound() {
    // 10-min TTL keeps the cache hot during normal traffic but lets a new
    // pricing fetch (24h cycle) eventually flow in.
    if (_upperBoundCache && (Date.now() - _upperBoundComputedAt) < 10 * 60_000) return _upperBoundCache;
    _upperBoundCache = _computeUpperBound();
    _upperBoundComputedAt = Date.now();
    return _upperBoundCache;
}

function resetUpperBoundCache() {
    _upperBoundCache = null;
    _upperBoundComputedAt = 0;
}

function _warnUnknownModel(modelName) {
    if (!modelName || _unknownModelWarned.has(modelName)) return;
    _unknownModelWarned.add(modelName);
    log.warn(`[ModelCosts] Unknown model '${modelName}' — using upper-bound rates; add it to pricing data or as a custom override.`);
}

/**
 * Get cost rates for a model (handles various ID formats).
 * Priority: custom override → self-hosted (€0) → community pricing data → null
 * @returns {{ input: number, output: number } | null}  prices per 1M tokens
 */
function getModelCost(modelName) {
    if (!modelName) return null;

    // 1. Custom override (exact match)
    const custom = getCustomOverrides();
    if (custom[modelName]) return custom[modelName];

    // 2. Self-hosted model → €0. This MUST come before the community-pricing
    // lookup: an open-weight model has a listed price at every cloud host that
    // serves it, and matching on that would bill a customer's own GPU at
    // Together/Fireworks rates. It also keeps local models away from the
    // unknown-model upper-bound fallback in computeCost.
    if (isLocalModel(modelName)) return LOCAL_MODEL_RATES;

    // 3. Scaleway-served model → Scaleway's own tariff. This MUST come before
    // the community-pricing lookup for the same reason self-hosted does: every
    // model Scaleway serves is open-weight and also sold by Fireworks, Groq,
    // Together and others, so the fuzzy "ends with /<id>" match would price a
    // Scaleway call at whichever host happens to sort first. The exact
    // scaleway/<vendor>/<id> key is preferred (it tracks the community data as
    // Scaleway's prices change); the catalog's published list price is the
    // fallback for models the database has not picked up yet.
    if (isScalewayServedModel(modelName)) {
        const exact = getPricingByKey(scalewayPricingKey(modelName));
        if (exact) return exact;
        const listed = getScalewayListPrice(modelName);
        if (listed) return listed;
    }

    // 3b. Mistral-served model → Mistral's own price, before the fuzzy lookup
    // for the Scaleway reason: Ministral and Mistral Small are open weights
    // that other hosts sell too. The ORDER is the reverse of Scaleway's,
    // though — the catalog's list price first, the community key second.
    // Mistral bills by `-latest` alias as often as by pinned id, and an alias
    // moves to each new model: the community entry for `mistral/mistral-small-latest`
    // keeps whatever the alias cost when it was entered (Small 3.2 at 0.1/0.3,
    // today it is Small 4 at 0.15/0.6). The catalog is dated; the key is the
    // fallback for ids it does not price.
    if (isMistralServedModel(modelName)) {
        const listed = getMistralListPrice(modelName);
        if (listed) return listed;
        const exact = getPricingByKey(mistralPricingKey(modelName));
        if (exact) return exact;
    }

    // 4. Community pricing lookup (handles provider prefixes + fuzzy matching)
    const pricing = getModelPricing(modelName);
    if (pricing) return pricing;

    // 5. Case-insensitive custom override match
    const lower = modelName.toLowerCase();
    for (const [key, val] of Object.entries(custom)) {
        if (key.toLowerCase() === lower) return val;
    }

    return null;
}

/**
 * Get the cache READ discount multiplier for a model's provider.
 * Cached input tokens are billed at this fraction of the normal input rate.
 */
function getCacheDiscount(model) {
    if (!model) return 1;
    const m = model.toLowerCase();
    // Anthropic/Claude: 10% of input across most of the family — but NOT all of
    // it. Fable 5.1 reads at $0.25/MTok against a $10 input rate (0.025x, a
    // quarter of Fable 5's), so a flat 0.1 would overbill it fourfold. The
    // per-model rate lives in the catalog; 0.1 remains the fallback there.
    if (/claude/.test(m)) {
        const { cacheReadDiscount } = require('../providers/claudeModels');
        return cacheReadDiscount(m);
    }
    // Google/Gemini: 2.5/3.x cached reads cost 10% of input (90% off);
    // legacy 2.0 was 25% (75% off). Only used when the pricing data has no
    // explicit cache_read rate — see computeCost's rates.cacheRead preference.
    if (/gemini/.test(m)) return /gemini-(2\.5|3)/.test(m) ? 0.1 : 0.25;
    // OpenAI: the discount is NOT uniform, which is why this used to be wrong.
    // Everything from GPT-5 on reads cached input at 10% of the normal rate;
    // the o-series sits between 25% and 50% per model. The catalog carries the
    // published cached rate per model, so derive the ratio from that and only
    // guess for ids it has never heard of.
    if (/gpt|o\d/.test(m)) {
        const { getOpenAIListPrice } = require('../providers/openaiModels');
        const price = getOpenAIListPrice(m);
        if (price && price.input > 0 && Number.isFinite(price.cachedInput)) {
            return price.cachedInput / price.input;
        }
        // Unknown OpenAI id: follow the generation. The GPT-4 era read cached
        // input at 50%; everything from GPT-5 on reads it at 10%.
        const { describeOpenAIModel } = require('../providers/openaiModels');
        return /^gpt-4/.test(describeOpenAIModel(m).family) ? 0.5 : 0.1;
    }
    // Mistral: cached input costs 10% of the input price on every current
    // model (docs.mistral.ai/studio/conversations/advanced/prompt-caching).
    // Read from the catalog so a model that differs one day needs one edit.
    if (isMistralServedModel(model) || /^(mistral|ministral|magistral|codestral|devstral|pixtral)-/.test(m)) {
        return mistralCacheReadRatio(m) ?? 0.1;
    }
    // Default: no discount (treat cached same as uncached)
    return 1;
}

/**
 * Get the cache WRITE multiplier for a model's provider.
 * Anthropic charges a premium on cache writes; the premium depends on the TTL
 * the request asked for (5-min default vs 1-hour extended).
 *
 * OpenAI DID bill cache writes at the uncached rate up to GPT-5.5, and from
 * GPT-5.6 on charges 1.25x for them. We cannot bill that difference: unlike
 * Anthropic, OpenAI reports no cache-write token count in `usage`, so
 * cache_creation_tokens is always 0 on that path and there is nothing to
 * multiply. Estimating the write volume would put an invented number on an
 * invoice, which is worse than a known-missing one — so this stays at 1 until
 * OpenAI exposes the count. Gemini genuinely does not bill writes separately.
 *
 * @param {string} model
 * @param {string|null} ttl  — '5m' (or null/falsy default) → 1.25×; '1h' → 2×
 */
function getCacheWriteMultiplier(model, ttl) {
    if (!model) return 1;
    const m = model.toLowerCase();
    if (/claude/.test(m)) {
        const { cacheWriteMultiplier } = require('../providers/claudeModels');
        return cacheWriteMultiplier(ttl);  // 5-min is the default
    }
    return 1;
}

/**
 * Uncached (full-price) input tokens for a call.
 *
 * The two provider families report input usage differently:
 *
 *  - Anthropic: `usage.input_tokens` is ALREADY the uncached remainder —
 *    `cache_read_input_tokens` and `cache_creation_input_tokens` are reported
 *    separately and are NOT included in it. `core/providers/claude.js` maps
 *    `prompt_tokens = usage.input_tokens` verbatim (and `usageStore` documents
 *    the same contract), so subtracting the cache pieces again zeroed the
 *    uncached input and billed it at nothing on every cache hit.
 *  - OpenAI / Gemini: `prompt_tokens` is the FULL input and the cached count is
 *    a subset of it, so the cache pieces must be subtracted.
 *
 * The `Math.max(0, …)` guard stays for the subtracting family: a provider that
 * reports a cached count larger than the prompt total must not produce a
 * negative (i.e. cost-reducing) input component.
 */
function _uncachedInputTokens(model, promptTokens, cachedTokens, cacheCreationTokens) {
    const m = String(model || '').toLowerCase();
    if (/claude/.test(m)) return Math.max(0, promptTokens);
    return Math.max(0, promptTokens - cachedTokens - cacheCreationTokens);
}

/**
 * Compute estimated cost for a single API call.
 * Supports cache-aware pricing — cached input tokens are billed at a read
 * discount, cache-creation tokens at a TTL-specific write premium.
 * @param {string} model
 * @param {number} promptTokens - Input tokens as the provider reports them: for
 *   Anthropic the uncached remainder, for OpenAI/Gemini the full input
 *   (cached tokens included). See `_uncachedInputTokens`.
 * @param {number} completionTokens - Output tokens (includes reasoning, billed at output rate)
 * @param {number} cachedTokens - Input tokens served from cache
 * @param {number} cacheCreationTokens - Anthropic cache write tokens
 * @param {string|null} cacheTtl - '5m' or '1h' — only meaningful for Anthropic cache writes
 * @returns {number} cost in USD
 */
function computeCost(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheCreationTokens = 0, cacheTtl = null) {
    let rates = getModelCost(model);
    if (!rates) {
        // Unknown model — fall back to the upper bound so we never silently
        // charge €0 for a real API call. The customer is over-billed
        // slightly until the model lands in the pricing data or an admin
        // adds a custom override.
        rates = _getUpperBound();
        if (!rates) {
            log.error(`[ModelCosts] No pricing data available (pricing fetch failed?); cost for '${model}' defaulting to 0.`);
            return 0;
        }
        _warnUnknownModel(model);
    }
    const uncachedInput = _uncachedInputTokens(model, promptTokens, cachedTokens, cacheCreationTokens);
    const cacheReadRate = _cacheReadRate(model, rates);
    const cacheWriteRate = rates.input * getCacheWriteMultiplier(model, cacheTtl);
    const base = ((uncachedInput / 1_000_000) * rates.input)
         + ((cachedTokens / 1_000_000) * cacheReadRate)
         + ((cacheCreationTokens / 1_000_000) * cacheWriteRate)
         + ((completionTokens / 1_000_000) * rates.output);
    return base * getRegionalUplift(model);
}

/**
 * Multiplier for a call answered by a regional-processing endpoint.
 *
 * OpenAI charges 10% more on its EU/regional domains for models released on or
 * after 2026-03-05. Keeping inference inside the EU is a deliberate, paid-for
 * choice, so it has to land on the invoice — silently absorbing it would make
 * EU-mode orgs look cheaper than they are and quietly eat the margin. Mistral
 * charges the same 10% on its regional endpoints, on every model.
 *
 * Reads the EU-served registry rather than a per-call flag, for the same reason
 * the local and Scaleway registries exist: cost accounting runs a long way from
 * the provider record.
 */
function getRegionalUplift(model) {
    if (!model) return 1;
    try {
        const { isEuServedModel, euUpliftApplies, EU_RESIDENCY_UPLIFT } = require('../providers/openaiModels');
        if (isEuServedModel(model) && euUpliftApplies(model)) return EU_RESIDENCY_UPLIFT;
    } catch (_) { /* registry unavailable — bill at the list rate */ }
    // Mistral's regional endpoints (api.eu / api.us) cost 1.1× on every model.
    const mistral = mistralRegionalUplift(model);
    if (mistral !== 1) return mistral;
    return 1;
}

/**
 * Resolve the per-token cached-read rate. Prefer the model's explicit
 * cache_read rate from the pricing data (accurate per model, auto-updating);
 * fall back to the provider discount heuristic when it's absent.
 */
function _cacheReadRate(model, rates) {
    if (rates && Number.isFinite(rates.cacheRead) && rates.cacheRead > 0) {
        return rates.cacheRead;
    }
    return rates.input * getCacheDiscount(model);
}

/**
 * Compute estimated cost split into input and output.
 * @returns {{ input_cost: number, output_cost: number }}
 */
function computeCostSplit(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheCreationTokens = 0, cacheTtl = null) {
    let rates = getModelCost(model);
    if (!rates) {
        rates = _getUpperBound();
        if (!rates) {
            log.error(`[ModelCosts] No pricing data available; split cost for '${model}' defaulting to 0.`);
            return { input_cost: 0, output_cost: 0 };
        }
        _warnUnknownModel(model);
    }
    const uncachedInput = _uncachedInputTokens(model, promptTokens, cachedTokens, cacheCreationTokens);
    const cacheReadRate = _cacheReadRate(model, rates);
    const cacheWriteRate = rates.input * getCacheWriteMultiplier(model, cacheTtl);
    // Same uplift as computeCost — the two must agree, or the split stops
    // summing to the stored total that routes/usage.js re-derives from it.
    const uplift = getRegionalUplift(model);
    return {
        input_cost: (((uncachedInput / 1_000_000) * rates.input)
                  + ((cachedTokens / 1_000_000) * cacheReadRate)
                  + ((cacheCreationTokens / 1_000_000) * cacheWriteRate)) * uplift,
        output_cost: ((completionTokens / 1_000_000) * rates.output) * uplift,
    };
}

/**
 * Get the full pricing map for the frontend.
 * Custom overrides are merged on top of community pricing data.
 */
function getAllModelCosts() {
    const { getAllModelPricing } = require('./pricingService');
    const pricingData = getAllModelPricing();
    const custom = getCustomOverrides();

    // Start with community pricing data (input/output + cached-read rate, drop provider)
    const merged = {};
    for (const [key, val] of Object.entries(pricingData)) {
        merged[key] = { input: val.input, output: val.output, cacheRead: val.cacheRead };
    }

    // Apply custom overrides on top (may omit cacheRead → frontend falls back to input)
    for (const [key, val] of Object.entries(custom)) {
        merged[key] = val;
    }

    return merged;
}

/**
 * Get structured cost data for the config UI.
 * Only returns models that have been used or have custom overrides.
 * @param {Array<{id: string, providerName?: string, providerType?: string}>|string[]} modelEntries
 * @returns {Array<{ model, input, output, isCustom, defaultInput, defaultOutput, provider }>}
 */
function getModelCostsForConfig(modelEntries = []) {
    const { getModelPricing } = require('./pricingService');
    const custom = getCustomOverrides();
    const result = [];
    const seen = new Set();

    // 1. Models with custom overrides (always shown)
    for (const [model, rates] of Object.entries(custom)) {
        const defaults = getModelPricing(model);
        result.push({
            model,
            input: rates.input,
            output: rates.output,
            isCustom: true,
            defaultInput: defaults?.input ?? null,
            defaultOutput: defaults?.output ?? null,
            provider: null,
        });
        seen.add(model);
    }

    // 2. Models from providers and usage history
    for (const entry of modelEntries) {
        const modelId = typeof entry === 'string' ? entry : entry.id;
        const providerName = typeof entry === 'string' ? null : (entry.providerName || null);
        const providerType = typeof entry === 'string' ? null : (entry.providerType || null);
        const uniqueKey = providerName ? `${providerName}::${modelId}` : modelId;

        if (seen.has(uniqueKey)) continue;
        seen.add(uniqueKey);

        // Skip custom overrides already added (only skip if no provider differentiation)
        if (!providerName && custom[modelId]) continue;

        const defaults = getModelPricing(modelId, providerType);
        result.push({
            model: modelId,
            input: defaults?.input ?? 0,
            output: defaults?.output ?? 0,
            isCustom: false,
            defaultInput: defaults?.input ?? null,
            defaultOutput: defaults?.output ?? null,
            provider: providerName,
        });
    }

    return result;
}

module.exports = {
    getModelCost,
    getCacheDiscount,
    getRegionalUplift,
    getCacheWriteMultiplier,
    computeCost,
    computeCostSplit,
    getAllModelCosts,
    getModelCostsForConfig,
    setModelCost,
    resetModelCost,
    refreshCustomOverrides,
};
