// @typecheck
/**
 * Model Cost Registry — AI model pricing, rated with the price IN FORCE when the
 * call was made.
 *
 * Pricing sources (in priority order):
 * 1. Custom admin overrides (persisted via configStore)
 * 2. Self-hosted models (Ollama / vLLM / llama.cpp / …) — always €0, strictly
 *    before any price lookup
 * 3. The price catalogue (table `model_price_catalog`, in-memory index in
 *    ../../stores/lib/priceCatalog.js): dated cards per provider/model/tier. The card whose
 *    valid_from <= call time < valid_to wins, so a future-dated card never touches
 *    a call made before it and an old call is never re-priced. A card is
 *    provider-specific by construction (a Scaleway card is Scaleway's tariff).
 * 4. Scaleway-served models — Scaleway's own tariff, never another host's rate
 *    for the same open weights
 * 5. Mistral-served models — Mistral's own list price, same reason
 * 6. Community pricing database (2600+ models, LiteLLM) and our own repo
 *    snapshots (the *Models.js catalogues)
 *
 * 3 is empty until the import job has filled it, so nothing changes for an
 * install without catalogue rows: 4-6 are the pre-existing behaviour.
 *
 * A model none of these knows is rated `cost_basis: 'unknown'`, from the nearest
 * same-family or same-provider model (unknownModelRate.js), never from the most
 * expensive model of all; it is noted in unknownModelRegistry.js. A self-hosted
 * model never gets there: it is priced at zero at step 2.
 *
 * Prices are per 1 million tokens, in the currency of the source (USD, except
 * Scaleway which quotes EUR). `rateUsage` is the one function that rates a call
 * and returns the evidence (rates used, source, catalogue version, cost basis);
 * `computeCost` and `computeCostSplit` are thin number-only wrappers over it.
 *
 * Stored-cost contract: usageStore.logUsage rates a call ONCE, at write time,
 * with the call's own timestamp, and stores the result and the rates on the row.
 * Nothing here re-prices history.
 */

const { getModelPricing, getPricingByKey, initPricing } = require('./pricingService');
const pricingService = require('./pricingService');
const priceCatalog = require('../../stores/lib/priceCatalog');
const { prepareCandidates, estimateRate } = require('./unknownModelRate');
const { recordUnknownModel, listUnknownModels, unknownModelStats, resetUnknownModels } = require('./unknownModelRegistry');
const { isLocalModel } = require('../providers/localModels');
const { getCustomOverrides, refreshCustomOverrides, setModelCost, resetModelCost, onOverridesChanged } = require('./costOverrides');
const {
    getCacheDiscount,
    getCacheWriteMultiplier,
    getRegionalUplift,
    billingTier: _billingTier,
    billingGeo: _billingGeo,
    DEFAULT_TIER_MULTIPLIER,
} = require('./rateRules');
const { azureModelFor } = require('../providers/azureDeployments');
const {
    isScalewayServedModel,
    scalewayPricingKey,
    getScalewayListPrice,
} = require('../providers/scalewayModels');
const {
    isMistralServedModel,
    mistralPricingKey,
    getMistralListPrice,
} = require('../providers/mistralModels');
const log = require('../../telemetry/log');

// Self-hosted inference has no per-token price. The rates below are the
// canonical "free" answer for a model the customer runs on their own hardware.
const LOCAL_MODEL_RATES = Object.freeze({ input: 0, output: 0, cacheRead: 0 });

// Initialize pricing data on startup (non-blocking)
initPricing();


// ─── Unknown models ──────────────────────────────────────────────────────────
//
// A model no source prices used to be billed at the most expensive input and
// output rate of every model we know (measured: ~20x any real model). It is now
// estimated from the nearest same-family or same-provider model (see
// unknownModelRate.js for the rules), and the donor list is memoised here: built
// from the catalogue rows in force at the call's time, our repo snapshots, the
// community data and the admin overrides, at most one rebuild per 10-minute bucket
// (so a new pricing fetch flows in, and a backdated call sees its own period's
// catalogue). Cleared when an override changes.

const ESTIMATE_BUCKET_MS = 10 * 60_000;
const ESTIMATE_CACHE_MAX = 500;
/** bucket -> prepared donors, newest few only. */
const _poolByBucket = new Map();
/** `${bucket}|${provider}|${model}` -> estimate (or null), cleared with the pools. */
const _estimates = new Map();

function resetEstimateCache() {
    _poolByBucket.clear();
    _estimates.clear();
}
onOverridesChanged(resetEstimateCache);

function _donorPool(atMs) {
    const bucket = Math.floor(atMs / ESTIMATE_BUCKET_MS);
    const hit = _poolByBucket.get(bucket);
    if (hit) return hit;
    const list = [];
    try {
        for (const row of priceCatalog.listActive({ at: atMs })) {
            list.push({ id: row.model_id, vendor: row.provider, input: row.input, output: row.output, cacheRead: row.cache_read, currency: row.currency, source: row.source });
        }
    } catch (e) { log.warn(`[ModelCosts] could not read the catalogue for an estimate: ${e.message}`); }
    try {
        if (typeof pricingService.listKnownPricing === 'function') list.push(...pricingService.listKnownPricing());
    } catch (e) { log.warn(`[ModelCosts] could not read the pricing data for an estimate: ${e.message}`); }
    for (const [id, o] of Object.entries(getCustomOverrides())) {
        list.push({ id, vendor: inferProviderType(id), input: Number(o?.input), output: Number(o?.output), cacheRead: null, currency: 'USD', source: 'override' });
    }
    const pool = prepareCandidates(list);
    if (_poolByBucket.size >= 4) _poolByBucket.delete(_poolByBucket.keys().next().value);
    _poolByBucket.set(bucket, pool);
    return pool;
}

/** The estimate for an unknown model (or null: none possible), memoised. */
function _estimateUnknown(model, vendor, atMs) {
    const bucket = Math.floor(atMs / ESTIMATE_BUCKET_MS);
    const key = `${bucket}|${vendor || ''}|${model}`;
    if (_estimates.has(key)) return _estimates.get(key);
    const est = estimateRate({ model, vendor, pool: _donorPool(atMs) });
    if (_estimates.size >= ESTIMATE_CACHE_MAX) _estimates.clear();
    _estimates.set(key, est);
    return est;
}

// ─── Rate cards ──────────────────────────────────────────────────────────────
//
// Every source below produces the same internal "card": the list rates of one
// model from one source at one moment, plus what the source knows about tiers and
// long context. `_resolveCard` walks the sources in precedence order and returns
// the first card; `rateUsage` turns a card and the billing facts of a call into a
// cost. `legacy` is the object the pre-catalogue API returned for that source,
// so getModelCost keeps its exact shape (and identity, for overrides).

/**
 * Which adapter family a bare model id belongs to, for the catalogue lookup.
 * Registry knowledge (Scaleway/Mistral serving) beats the name; null when the id
 * says nothing, in which case only an unambiguous catalogue row is used.
 */
function inferProviderType(model) {
    if (!model) return null;
    const m = String(model).toLowerCase();
    if (isScalewayServedModel(model)) return 'scaleway';
    if (isMistralServedModel(model)) return 'mistral';
    if (/^claude/.test(m)) return 'claude';
    if (/^gemini/.test(m)) return 'google';
    if (/^eugpt/.test(m)) return 'eugpt';
    if (/^(gpt|chatgpt|o\d|text-embedding|dall-e|whisper|tts-)/.test(m)) return 'openai';
    if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|voxtral)-/.test(m)) return 'mistral';
    return null;
}

/** Providers to try in the catalogue, most specific first. */
function _catalogProviders(model, hint) {
    const out = [];
    const h = priceCatalog.normalizeProvider(hint);
    if (h) {
        out.push(h);
        // A host that resells another vendor's models prices them like the vendor
        // when it has no card of its own; the card is then a list price.
        if (h === 'azure' || h === 'google-vertex') {
            const family = inferProviderType(model);
            if (family && family !== h) out.push(family);
        }
        return out;
    }
    const inferred = inferProviderType(model);
    if (inferred) return [inferred];
    // Nothing in the id tells the family: use the catalogue only when exactly one
    // provider has a card for it (never pick between hosts of the same weights).
    const only = priceCatalog.providersFor(model);
    return only.length === 1 ? only : [];
}

/** Catalogue sources whose cards are community/repo data rather than a provider's own price. */
const LIST_SOURCE = /^(litellm|community|repo|openrouter|estimate)/i;

function _basisForSource(source) {
    return LIST_SOURCE.test(String(source || '')) ? 'list' : 'exact';
}

function _cardFromRow(row, std, { viaFamily }) {
    const mult = row.multipliers || (std && std.multipliers) || null;
    return {
        kind: 'catalog',
        source: row.source,
        currency: row.currency,
        catalogVersion: row.catalog_version,
        validFrom: row.valid_from,
        basis: viaFamily ? 'list' : _basisForSource(row.source),
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite5m: row.cache_write_5m,
        cacheWrite1h: row.cache_write_1h,
        longCtx: row.long_ctx_threshold ? { threshold: row.long_ctx_threshold, rates: row.long_ctx_rates } : null,
        tierPriced: row.tier !== 'standard',
        tierRates: null,
        multipliers: mult,
        legacy: { input: row.input, output: row.output, cacheRead: row.cache_read ?? 0 },
    };
}

function _catalogCard(model, ctx) {
    const providers = _catalogProviders(model, ctx.provider);
    for (let i = 0; i < providers.length; i++) {
        const p = providers[i];
        const std = priceCatalog.lookup({ provider: p, model, tier: 'standard', at: ctx.at });
        const tiered = ctx.tier && ctx.tier !== 'standard'
            ? priceCatalog.lookup({ provider: p, model, tier: ctx.tier, at: ctx.at })
            : null;
        const row = tiered || std;
        if (row) return _cardFromRow(row, std, { viaFamily: i > 0 });
    }
    return null;
}

function _simpleCard(kind, source, currency, basis, rates, extra = {}) {
    return {
        kind, source, currency, catalogVersion: null, validFrom: null, basis,
        input: rates.input, output: rates.output,
        cacheRead: Number.isFinite(rates.cacheRead) ? rates.cacheRead : null,
        cacheWrite5m: null, cacheWrite1h: null,
        longCtx: null, tierPriced: false, multipliers: null, tierRates: null,
        legacy: rates,
        ...extra,
    };
}

function _communityCard(model) {
    const detail = typeof pricingService.getModelPricingDetail === 'function'
        ? pricingService.getModelPricingDetail(model)
        : null;
    if (detail) {
        const { source, tiers, longCtx } = detail;
        const rates = { input: detail.input, output: detail.output, cacheRead: detail.cacheRead };
        return _simpleCard('community', source === 'repo' ? 'repo' : 'litellm', 'USD', 'list', rates, {
            tierRates: tiers && Object.keys(tiers).length ? tiers : null,
            longCtx: longCtx
                ? { threshold: longCtx.threshold, rates: { input: longCtx.input, output: longCtx.output, ...(longCtx.cacheRead !== undefined ? { cache_read: longCtx.cacheRead } : {}) } }
                : null,
            legacy: rates,
        });
    }
    const pricing = getModelPricing(model);
    return pricing ? _simpleCard('community', 'litellm', 'USD', 'list', pricing, { legacy: pricing }) : null;
}

/**
 * The first card in precedence order, or null when no source prices the model.
 * @param {string} modelName
 * @param {{ provider?: string, at?: number, tier?: string }} [ctx]
 */
function _resolveCard(modelName, ctx = {}) {
    if (!modelName) return null;

    // 1. Custom override (exact match)
    const custom = getCustomOverrides();
    if (custom[modelName]) {
        const o = custom[modelName];
        return _simpleCard('override', 'override', 'USD', 'exact', o, { legacy: o });
    }

    // 1b. A custom-named Azure deployment (`prod-chat=gpt-6-astra`) is priced
    // as the model behind it. After the override, so an admin can still price
    // the deployment itself.
    const azureModel = azureModelFor(modelName);
    if (azureModel !== modelName) return _resolveCard(azureModel, { ...ctx, provider: ctx.provider || 'azure' });

    // 2. Self-hosted model → €0. This MUST come before every price lookup,
    // the catalogue included: an open-weight model has a listed price at every
    // cloud host that serves it, and matching on that would bill a customer's own
    // GPU at Together/Fireworks rates. It also keeps local models away from the
    // unknown-model path (estimate, and a flag in the registry).
    if (isLocalModel(modelName)) {
        return _simpleCard('local', 'local', 'USD', 'local', LOCAL_MODEL_RATES, { legacy: LOCAL_MODEL_RATES });
    }

    // 3. The dated catalogue.
    const fromCatalog = _catalogCard(modelName, ctx);
    if (fromCatalog) return fromCatalog;

    // 4. Scaleway-served model → Scaleway's own tariff. This MUST come before
    // the community-pricing lookup for the same reason self-hosted does: every
    // model Scaleway serves is open-weight and also sold by Fireworks, Groq,
    // Together and others, so the fuzzy "ends with /<id>" match would price a
    // Scaleway call at whichever host happens to sort first. The exact
    // scaleway/<vendor>/<id> key is preferred (it tracks the community data as
    // Scaleway's prices change); the catalog's published list price is the
    // fallback for models the database has not picked up yet. Both carry
    // Scaleway's own EUR figures, so the card is EUR: no USD round-trip.
    if (isScalewayServedModel(modelName)) {
        const exact = getPricingByKey(scalewayPricingKey(modelName));
        if (exact) return _simpleCard('community', 'litellm:scaleway', 'EUR', 'list', exact, { legacy: exact });
        const listed = getScalewayListPrice(modelName);
        if (listed) return _simpleCard('repo', 'repo:scaleway', 'EUR', 'list', listed, { legacy: listed });
    }

    // 4b. Mistral-served model → Mistral's own price, before the fuzzy lookup
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
        if (listed) return _simpleCard('repo', 'repo:mistral', 'USD', 'list', listed, { legacy: listed });
        const exact = getPricingByKey(mistralPricingKey(modelName));
        if (exact) return _simpleCard('community', 'litellm:mistral', 'USD', 'list', exact, { legacy: exact });
    }

    // 5. Community pricing lookup (handles provider prefixes + fuzzy matching)
    const community = _communityCard(modelName);
    if (community) return community;

    // 6. Case-insensitive custom override match
    const lower = modelName.toLowerCase();
    for (const [key, val] of Object.entries(custom)) {
        if (key.toLowerCase() === lower) return _simpleCard('override', 'override', 'USD', 'exact', val, { legacy: val });
    }

    return null;
}

/**
 * Get cost rates for a model (handles various ID formats).
 * Priority: custom override → self-hosted (€0) → price catalogue → provider
 * tariffs → community pricing data → null
 *
 * @param {string} modelName
 * @param {any} [facts]  `{ at | timestamp, provider | provider_type, service_tier, traffic_type }`:
 *   the call's timestamp (default now) and provider/tier, to pick the catalogue
 *   card in force at that moment
 * @returns {{ input: number, output: number } | null}  prices per 1M tokens
 */
function getModelCost(modelName, facts = {}) {
    if (!modelName) return null;
    const card = _resolveCard(modelName, {
        provider: facts.provider_type || facts.provider,
        at: priceCatalog.toMs(facts.at ?? facts.timestamp),
        tier: _billingTier(facts.service_tier, facts.traffic_type).tier,
    });
    return card ? card.legacy : null;
}



/** Cards that carry no tier or geo structure of their own: a flat rate. */
const FLAT_CARDS = ['override', 'local', 'estimate'];

const _clampTokens = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Rate one call: the price card in force at the call's timestamp, applied to the
 * call's billing facts. This is the single place a call is priced.
 *
 * Input (all optional but `model`; the shape of a usageStore log entry, which is
 * the normalised usage of core/providers/usageNormalizer plus bookkeeping):
 *   timestamp | at            when the call happened (default now): picks the card
 *   provider_type | provider  adapter type, when the caller knows it
 *   prompt_tokens             input tokens as the provider reports them
 *   completion_tokens, cached_tokens, cache_creation_tokens
 *   cache_creation_5m_tokens / cache_creation_1h_tokens   the per-TTL split of the write
 *   cache_ttl                 legacy single TTL for a write without a split
 *   cache_creation_ttl_assumed  the TTL was a guess (priced, but flagged 'estimated')
 *   prompt_includes_cache     false for Anthropic (prompt_tokens is the uncached remainder)
 *   service_tier, traffic_type, inference_geo
 *
 * @returns {{
 *   cost: number, input_cost: number, output_cost: number, currency: string,
 *   model: string, provider: string|null, at: string,
 *   tier: string, inference_geo: string|null, long_context: boolean,
 *   source: string, catalog_version: string|null, valid_from: string|null,
 *   cost_basis: 'exact'|'list'|'estimated'|'unknown'|'local',
 *   rates: { input: number, output: number, cache_read: number, cache_write_5m: number, cache_write_1h: number },
 *   multiplier: { tier_input: number, tier_output: number, geo: number, regional: number, total: number },
 *   price_input: number, price_output: number, price_cache_read: number, price_cache_write: number,
 *   notes: string[]
 * }}
 */
function rateUsage(entry = {}) {
    const model = entry.model;
    const atMs = priceCatalog.toMs(entry.timestamp ?? entry.at);
    const providerHint = entry.provider_type || entry.provider;
    const { tier, unrecognised: tierUnrecognised } = _billingTier(entry.service_tier, entry.traffic_type);
    const geo = _billingGeo(entry.inference_geo);
    const notes = [];

    const prompt = _clampTokens(entry.prompt_tokens);
    const completion = _clampTokens(entry.completion_tokens);
    const cached = _clampTokens(entry.cached_tokens);
    let creation = _clampTokens(entry.cache_creation_tokens);
    let n5 = _clampTokens(entry.cache_creation_5m_tokens);
    let n1 = _clampTokens(entry.cache_creation_1h_tokens);
    if (n5 + n1 > 0) {
        // A split wins. A write total that exceeds it keeps its remainder at the
        // legacy TTL; a split that exceeds the total raises the total.
        if (creation > n5 + n1) { if (entry.cache_ttl === '1h') n1 += creation - n5 - n1; else n5 += creation - n5 - n1; }
        creation = n5 + n1;
    } else if (creation > 0) {
        if (entry.cache_ttl === '1h') n1 = creation; else n5 = creation;
    }

    const base = {
        model: model || '',
        provider: priceCatalog.normalizeProvider(providerHint) || inferProviderType(model),
        at: new Date(atMs).toISOString(),
        tier,
        inference_geo: geo,
    };

    let card = _resolveCard(model, { provider: providerHint, at: atMs, tier });
    // A card with a non-finite or negative rate (a corrupt override, a garbled
    // community entry) must not turn into a NaN or negative cost on an invoice:
    // it is treated like an unknown model.
    if (card && !(Number.isFinite(card.input) && Number.isFinite(card.output) && card.input >= 0 && card.output >= 0)) {
        log.warn(`[ModelCosts] ignoring an invalid price for '${model}' (source ${card.source})`);
        notes.push('invalid_rates_ignored');
        card = null;
    }
    if (!card) {
        // Unknown model. Never the most expensive model of all: the nearest
        // same-family / same-provider model is the estimate (cost_basis stays
        // 'unknown', the source and notes say how the rate came about), and the
        // registry keeps count so an admin can fix the mapping or add the price.
        // A self-hosted model cannot get here (it was priced at zero above).
        const resolvedModel = azureModelFor(model);
        const vendor = base.provider || inferProviderType(resolvedModel);
        const unmapped = vendor === 'azure' && resolvedModel === model;
        const est = _estimateUnknown(resolvedModel, vendor, atMs);
        notes.push('unknown_model');
        if (unmapped) notes.push('unmapped_azure_deployment');
        recordUnknownModel({
            model: resolvedModel,
            provider: vendor,
            reason: unmapped ? 'unmapped_deployment' : 'unknown_model',
            deployment: resolvedModel !== model ? model : null,
            estimate: est,
        });
        if (!est) {
            // Nothing to borrow from. No number is invented: the row is flagged
            // and costs 0 until the model is priced or mapped.
            notes.push('no_price_data');
            return {
                ...base, cost: 0, input_cost: 0, output_cost: 0, currency: 'USD', long_context: false,
                source: 'none', catalog_version: null, valid_from: null, cost_basis: 'unknown',
                rates: { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
                multiplier: { tier_input: 1, tier_output: 1, geo: 1, regional: 1, total: 1 },
                price_input: 0, price_output: 0, price_cache_read: 0, price_cache_write: 0,
                notes,
            };
        }
        notes.push(est.level === 'family' ? 'estimate_family' : 'estimate_provider');
        card = _simpleCard('estimate', est.source, est.currency, 'unknown', est);
    }
    let basis = card.basis;

    // ── token accounting ────────────────────────────────────────────────────
    // The two provider families report input usage differently:
    //  - Anthropic: `usage.input_tokens` (our prompt_tokens) is ALREADY the
    //    uncached remainder — cache read and write are reported next to it and
    //    are NOT included. Subtracting them again zeroed the uncached input and
    //    billed it at nothing on every cache hit.
    //  - OpenAI / Gemini / Mistral / Scaleway: prompt_tokens is the FULL input
    //    and the cached count is a subset of it, so the cache pieces are
    //    subtracted (Math.max guards a provider that reports a cached count
    //    above the total: never a negative, cost-reducing input component).
    // The normalised usage says which it is (`prompt_includes_cache`); a legacy
    // caller without the flag is told apart by model name, as before.
    const includesCache = typeof entry.prompt_includes_cache === 'boolean'
        ? entry.prompt_includes_cache
        : !/claude/.test(String(model || '').toLowerCase());
    const uncachedInput = includesCache ? Math.max(0, prompt - cached - creation) : Math.max(0, prompt);
    const totalInput = includesCache ? prompt : prompt + cached + creation;

    // ── list rates of the card (standard tier), cache rates resolved ────────
    const input = card.input;
    const output = card.output;
    let rates = {
        input,
        output,
        cacheRead: Number.isFinite(card.cacheRead) && card.cacheRead > 0 ? card.cacheRead : input * getCacheDiscount(model),
        w5: Number.isFinite(card.cacheWrite5m) ? card.cacheWrite5m : input * getCacheWriteMultiplier(model, '5m'),
        w1: Number.isFinite(card.cacheWrite1h) ? card.cacheWrite1h : input * getCacheWriteMultiplier(model, '1h'),
    };

    // ── long-context tier: the whole request above the threshold ────────────
    let longContext = false;
    if (card.longCtx && totalInput > card.longCtx.threshold) {
        const L = card.longCtx.rates || {};
        const lin = Number.isFinite(L.input) ? L.input : rates.input;
        const ratio = rates.input > 0 ? lin / rates.input : 1;
        rates = {
            input: lin,
            output: Number.isFinite(L.output) ? L.output : rates.output,
            cacheRead: Number.isFinite(L.cache_read) ? L.cache_read : rates.cacheRead * ratio,
            w5: Number.isFinite(L.cache_write_5m) ? L.cache_write_5m : rates.w5 * ratio,
            w1: Number.isFinite(L.cache_write_1h) ? L.cache_write_1h : rates.w1 * ratio,
        };
        longContext = true;
    }

    // ── service tier ────────────────────────────────────────────────────────
    // A catalogue card of the tier itself is already priced; an admin override
    // and a local/estimate card are flat. Otherwise: the source's own tier
    // rate, then the card's multiplier, then the documented default.
    let tierIn = 1;
    let tierOut = 1;
    if (tierUnrecognised) { notes.push('tier_unrecognised'); }
    if (tier !== 'standard' && !card.tierPriced && !FLAT_CARDS.includes(card.kind)) {
        const abs = card.tierRates && card.tierRates[tier];
        const mult = card.multipliers && card.multipliers[tier];
        if (abs && input > 0) {
            tierIn = abs.input / input;
            tierOut = output > 0 ? abs.output / output : tierIn;
        } else if (Number.isFinite(mult)) {
            tierIn = mult; tierOut = mult;
        } else if (Object.prototype.hasOwnProperty.call(DEFAULT_TIER_MULTIPLIER, tier)) {
            tierIn = DEFAULT_TIER_MULTIPLIER[tier]; tierOut = tierIn;
            notes.push(`tier_${tier}_default_multiplier`);
        } else {
            notes.push(`tier_${tier}_multiplier_unknown`);
        }
    }

    // ── geo and regional ────────────────────────────────────────────────────
    let geoMult = 1;
    if (geo && !FLAT_CARDS.includes(card.kind)) {
        const g = card.multipliers && card.multipliers.geo && card.multipliers.geo[geo];
        if (Number.isFinite(g)) geoMult = g;
        else notes.push(`geo_${geo}_multiplier_unknown`);
    }
    // The registry says whether the call went to a regional endpoint; a catalogue
    // card may carry the factor, the built-in 1.1 remains the fallback.
    const legacyUplift = getRegionalUplift(model);
    const regional = legacyUplift !== 1 && card.multipliers && Number.isFinite(card.multipliers.regional)
        ? card.multipliers.regional
        : legacyUplift;
    const total = geoMult * regional;

    const r = {
        input: rates.input * tierIn,
        output: rates.output * tierOut,
        cacheRead: rates.cacheRead * tierIn,
        w5: rates.w5 * tierIn,
        w1: rates.w1 * tierIn,
    };
    // A source that gives the tier's own cached-read rate (flex/priority) is exact.
    if (tier !== 'standard' && !longContext && card.tierRates && card.tierRates[tier] && Number.isFinite(card.tierRates[tier].cacheRead)) {
        r.cacheRead = card.tierRates[tier].cacheRead;
    }

    // ── cost (same order as the pre-catalogue formula, so unchanged inputs give unchanged numbers) ──
    const inputCost = (((uncachedInput / 1_000_000) * r.input)
        + ((cached / 1_000_000) * r.cacheRead)
        + ((n5 / 1_000_000) * r.w5)
        + ((n1 / 1_000_000) * r.w1)) * total;
    const outputCost = ((completion / 1_000_000) * r.output) * total;
    const cost = (((uncachedInput / 1_000_000) * r.input)
        + ((cached / 1_000_000) * r.cacheRead)
        + ((n5 / 1_000_000) * r.w5)
        + ((n1 / 1_000_000) * r.w1)
        + ((completion / 1_000_000) * r.output)) * total;

    // ── cost basis ──────────────────────────────────────────────────────────
    if (creation > 0 && entry.cache_creation_ttl_assumed && r.w5 !== r.w1) notes.push('cache_ttl_assumed');
    if ((basis === 'exact' || basis === 'list') && notes.some((n) => n === 'tier_unrecognised' || n.endsWith('_default_multiplier') || n.endsWith('_multiplier_unknown') || n === 'cache_ttl_assumed')) {
        basis = 'estimated';
    }

    // The cache-write rate that was charged: the TTL part used, or the token-weighted mean of a mixed write.
    const writeRate = creation > 0 ? ((n5 * r.w5) + (n1 * r.w1)) / creation : r.w5;
    return {
        ...base,
        cost, input_cost: inputCost, output_cost: outputCost,
        currency: card.currency,
        long_context: longContext,
        source: card.source,
        catalog_version: card.catalogVersion,
        valid_from: card.validFrom,
        cost_basis: basis,
        rates: { input: rates.input, output: rates.output, cache_read: rates.cacheRead, cache_write_5m: rates.w5, cache_write_1h: rates.w1 },
        multiplier: { tier_input: tierIn, tier_output: tierOut, geo: geoMult, regional, total },
        price_input: r.input * total,
        price_output: r.output * total,
        price_cache_read: r.cacheRead * total,
        price_cache_write: writeRate * total,
        notes,
    };
}

/**
 * The model a call is billed AND logged as. On Azure the id a request carries is
 * a deployment name the admin chose (`prod-chat`); the model behind it comes from
 * the deployment list (`prod-chat=gpt-6-astra`, azureDeployments.js, the same
 * registry the Azure adapter's `_modelFor` reads). A call of another provider keeps
 * its id: only an Azure call, or one that does not say, is looked up.
 * @param {string} model
 * @param {string} [providerType]
 */
function resolveBilledModel(model, providerType) {
    if (!model || typeof model !== 'string') return model;
    const p = priceCatalog.normalizeProvider(providerType);
    return p && p !== 'azure' ? model : azureModelFor(model);
}

/**
 * Compute estimated cost for a single API call (number only; see `rateUsage` for
 * the evidence behind it).
 * Supports cache-aware pricing — cached input tokens are billed at a read
 * discount, cache-creation tokens at a TTL-specific write premium.
 * @param {string} model
 * @param {number} promptTokens - Input tokens as the provider reports them: for
 *   Anthropic the uncached remainder, for OpenAI/Gemini the full input
 *   (cached tokens included). See the token accounting in `rateUsage`.
 * @param {number} completionTokens - Output tokens (includes reasoning, billed at output rate)
 * @param {number} cachedTokens - Input tokens served from cache
 * @param {number} cacheCreationTokens - Anthropic cache write tokens
 * @param {string|null} cacheTtl - '5m' or '1h' — only meaningful for Anthropic cache writes
 * @param {object} [facts] - timestamp, service_tier, inference_geo, cache_creation_5m/1h_tokens, ...
 *   (see rateUsage); without it the call is rated now, at the standard tier
 * @returns {number} cost in the currency of the price source (USD, except Scaleway: EUR)
 */
function computeCost(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheCreationTokens = 0, cacheTtl = null, facts = {}) {
    return rateUsage({
        ...facts,
        model,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cached_tokens: cachedTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_ttl: cacheTtl,
    }).cost;
}


/**
 * Compute estimated cost split into input and output.
 * Same rating (and the same uplift) as computeCost — the two must agree, or the
 * split stops summing to the stored total that routes/usage.js re-derives from it.
 * @returns {{ input_cost: number, output_cost: number }}
 */
function computeCostSplit(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheCreationTokens = 0, cacheTtl = null, facts = {}) {
    const r = rateUsage({
        ...facts,
        model,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cached_tokens: cachedTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_ttl: cacheTtl,
    });
    return { input_cost: r.input_cost, output_cost: r.output_cost };
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
    rateUsage,
    resolveBilledModel,
    inferProviderType,
    getAllModelCosts,
    getModelCostsForConfig,
    setModelCost,
    resetModelCost,
    refreshCustomOverrides,
    listUnknownModels,
    unknownModelStats,
    resetUnknownModels,
};
