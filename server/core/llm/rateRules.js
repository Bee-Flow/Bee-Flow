// @typecheck
/**
 * Per-provider rating rules, split out of modelCosts.js: the cache read discount,
 * the cache write premium and the regional-endpoint uplift for a model, and how a
 * provider's reported service tier and inference geo map onto our billing facts.
 * They apply when a price card does not carry the rate itself.
 */

const { azureModelFor } = require('../providers/azureDeployments');
const {
    isMistralServedModel,
    mistralCacheReadRatio,
    mistralRegionalUplift,
} = require('../providers/mistralModels');

/**
 * Get the cache READ discount multiplier for a model's provider.
 * Cached input tokens are billed at this fraction of the normal input rate.
 */
function getCacheDiscount(model) {
    if (!model) return 1;
    const m = azureModelFor(model).toLowerCase();
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
    const m = azureModelFor(model).toLowerCase();
    if (/claude/.test(m)) {
        const { cacheWriteMultiplier } = require('../providers/claudeModels');
        return cacheWriteMultiplier(ttl);  // 5-min is the default
    }
    return 1;
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

// ─── Billing facts ───────────────────────────────────────────────────────────

/**
 * The billing tier a provider reported, as one of standard | batch | flex |
 * priority. Anthropic reports `standard`/`priority`/`batch`, OpenAI
 * `default`/`flex`/`priority`/`auto`, Vertex a traffic type
 * (`ON_DEMAND`, `ON_DEMAND_PRIORITY`, `ON_DEMAND_FLEX`, ...). A value we do not
 * recognise (OpenAI `scale`, Vertex `PROVISIONED_THROUGHPUT`: committed capacity
 * that is not billed per token) is priced as standard and flagged, so the row
 * says "estimated" instead of claiming an exact rate.
 */
const TIER_ALIASES = Object.freeze({
    '': 'standard', standard: 'standard', default: 'standard', auto: 'standard', standard_only: 'standard',
    on_demand: 'standard', not_available: 'standard', unspecified: 'standard', traffic_type_unspecified: 'standard',
    batch: 'batch', batches: 'batch',
    flex: 'flex', on_demand_flex: 'flex',
    priority: 'priority', on_demand_priority: 'priority',
});

function _billingTier(serviceTier, trafficType) {
    // The tier the provider billed wins; a Vertex traffic type is consulted only
    // when there is no service tier (Vertex has none).
    const raw = String(serviceTier || trafficType || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TIER_ALIASES, raw)) return { tier: TIER_ALIASES[raw], unrecognised: false };
    return { tier: 'standard', unrecognised: true };
}

/** Anthropic `inference_geo`: global/unspecified bills at the list rate, a pinned geo may carry a premium. */
function _billingGeo(raw) {
    const g = String(raw || '').trim().toLowerCase();
    return !g || g === 'global' || g === 'not_available' || g === 'unspecified' ? null : g;
}

// Tier multipliers when the source does not carry the tier's own rate. Batch and
// flex are half price at every provider that offers them (documented, uniform);
// the priority premium differs per provider and model and has no safe default,
// so it stays at 1 and the call is flagged "estimated".
const DEFAULT_TIER_MULTIPLIER = Object.freeze({ batch: 0.5, flex: 0.5 });

module.exports = {
    getCacheDiscount,
    getCacheWriteMultiplier,
    getRegionalUplift,
    billingTier: _billingTier,
    billingGeo: _billingGeo,
    DEFAULT_TIER_MULTIPLIER,
};
