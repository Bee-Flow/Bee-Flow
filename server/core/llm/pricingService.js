// @typecheck
/**
 * Pricing Service — fetches model pricing from a community-maintained
 * open-source pricing database (2000+ models from all providers).
 * Cached in memory with a 24-hour TTL.
 */
const log = require('../../telemetry/log');

const PRICING_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

let _cachedPricing = null;
let _cacheTimestamp = null;
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

/**
 * Fetch the full pricing JSON (2000+ models).
 * Uses a 24h in-memory cache.
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Object>} Map of model keys → pricing objects
 */
async function fetchAllPricing(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && _cachedPricing && (now - _cacheTimestamp) < CACHE_TTL) {
        return _cachedPricing;
    }

    try {
        log.info('[PricingService] Fetching pricing data...');
        const res = await fetch(PRICING_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        // Remove the meta spec entry
        delete data['sample_spec'];

        _cachedPricing = data;
        _cacheTimestamp = now;

        log.info(`[PricingService] Cached pricing for ${Object.keys(data).length} models`);
        return data;
    } catch (e) {
        log.error('[PricingService] Failed to fetch pricing:', e.message);
        // Return cached data if available (even if expired)
        if (_cachedPricing) return _cachedPricing;
        return {};
    }
}

// ─── Provider prefix mapping ────────────────────────────────────────────────
// The pricing database uses prefixed keys like "openai/gpt-4o", "mistral/mistral-large-latest", etc.
// Our system uses bare model IDs. This maps provider types to pricing-DB prefixes.

const PROVIDER_PREFIXES = {
    openai: ['', 'openai/'],
    mistral: ['mistral/', ''],
    claude: ['', 'anthropic/', 'claude-'],
    google: ['gemini/', ''],
    'google-vertex': ['vertex_ai/gemini-', 'vertex_ai/', 'gemini/', ''],
    // Scaleway keys carry the model's vendor as a middle segment
    // ("scaleway/qwen/qwen3.6-35b-a3b"), so the prefix is provider + vendor.
    // Deliberately no bare '' entry: these are open-weight models that a dozen
    // other hosts also sell, at their own prices.
    scaleway: [
        'scaleway/qwen/', 'scaleway/openai/', 'scaleway/mistralai/',
        'scaleway/google/', 'scaleway/meta/', 'scaleway/BAAI/',
        'scaleway/deepseek/', 'scaleway/zai/', 'scaleway/hcompany/',
    ],
};

// Providers whose models are open weights sold by many hosts — an exact key
// match or nothing, never the fuzzy tail match. See getModelPricing.
const STRICT_PROVIDERS = new Set(['scaleway']);

// ─── Fallback pricing for models not yet in the community database ──────────
// Prices are per 1M tokens (USD). Sourced from official provider pages.
//
// This matters more than it looks: without a price, rateUsage can only
// ESTIMATE the call from the nearest known model (cost_basis 'unknown', see
// unknownModelRate.js), and an estimate lands on real PAYG invoices. The
// community database lags a new OpenAI model by days to weeks, which is exactly
// the window in which a freshly released flagship gets used.
//
// Consulted only AFTER the community database, so a price cut upstream still
// wins over our snapshot.
const { listPricedModels } = require('../providers/openaiModels');
// Anthropic was missing here entirely, so a Claude model the community database
// had not picked up yet — a freshly released flagship, exactly when it gets
// used — had no price at all and was only estimated.
const { listPricedModels: listClaudePricedModels } = require('../providers/claudeModels');

const FALLBACK_PRICING = {
    ...listPricedModels(),
    ...listClaudePricedModels(),
};

/**
 * Look up the cost for a model ID, trying various key patterns.
 * Returns { input, output } in USD per 1M tokens, or null if not found.
 *
 * @param {string} modelId - The bare model ID (e.g. "gpt-4o", "mistral-large-latest")
 * @param {string} [providerType] - Optional provider type for prefix hints
 * @returns {{ input: number, output: number } | null}
 */
function getModelPricing(modelId, providerType) {
    if (!modelId) return null;
    if (!_cachedPricing) return _staticFallback(modelId);
    const hit = _findEntry(modelId, providerType);
    return hit ? _extract(hit.entry) : _staticFallback(modelId);
}

const _extract = (entry) => ({
    input: (entry.input_cost_per_token || 0) * 1_000_000,
    output: (entry.output_cost_per_token || 0) * 1_000_000,
    // Per-model cached-read rate (e.g. Gemini 2.5/3.x = 10% of input).
    // 0 when the provider doesn't publish one → callers fall back to the
    // provider discount heuristic in modelCosts.getCacheDiscount().
    cacheRead: (entry.cache_read_input_token_cost || 0) * 1_000_000,
});
const _valid = (entry) => entry && (entry.input_cost_per_token != null || entry.output_cost_per_token != null);

/**
 * The community-database entry for a model, by the prefix pass and then the
 * fuzzy pass. The one resolution both getModelPricing and
 * getModelPricingDetail go through, so the detail can never describe a
 * different entry than the price that was billed.
 * @returns {{ key: string, entry: any } | null}
 */
function _findEntry(modelId, providerType) {
    // Build candidate keys to try
    const prefixes = providerType && PROVIDER_PREFIXES[providerType]
        ? PROVIDER_PREFIXES[providerType]
        : ['', 'openai/', 'mistral/', 'gemini/', 'vertex_ai/', 'anthropic/'];

    // Build candidate model IDs (original + without -latest)
    const candidates = [modelId];
    if (modelId.endsWith('-latest')) {
        candidates.push(modelId.replace(/-latest$/, ''));
    }

    // Try each prefix + candidate combo
    for (const id of candidates) {
        for (const prefix of prefixes) {
            const entry = _cachedPricing[prefix + id];
            if (_valid(entry)) return { key: prefix + id, entry };
        }
    }

    // Providers that serve open weights other hosts also sell cannot use the
    // fuzzy pass below: "gpt-oss-120b" ends a key for half a dozen hosts, and
    // the first one wins. Better no price (caller falls back) than another
    // host's price presented as this one's.
    if (STRICT_PROVIDERS.has(providerType)) return null;

    // Fuzzy: find a key that ends with /modelId or contains the base name
    const baseName = modelId.replace(/-latest$/, '').replace(/-\d{4}$/, '');
    for (const [key, entry] of Object.entries(_cachedPricing)) {
        if (!_valid(entry)) continue;
        if (!(key.endsWith('/' + modelId) || key.endsWith('/' + baseName))) continue;
        // OpenAI's own models are resold under keys like "openrouter/openai/…"
        // and "bedrock/…" at the reseller's margin. The exact-prefix pass above
        // already covers the real thing, so a fuzzy hit on a foreign host here
        // is a wrong price, not a lucky one.
        if (providerType === 'openai' && !key.startsWith('openai/')) continue;
        return { key, entry };
    }
    return null;
}

/** A per-token cost field in the data, as USD per 1M tokens; undefined when absent or not a sane number. */
function _perM(entry, field) {
    const v = entry[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
    return v * 1_000_000;
}

/**
 * What the data says beyond the flat input/output rate: the per-tier rates
 * (batch / flex / priority) and the long-context tier ("above N tokens the
 * whole request is billed at ...").
 *
 *   tiers      { batch|flex|priority: { input, output, cacheRead? } } absolute USD/1M
 *   longCtx    { threshold, input, output, cacheRead? } absolute USD/1M, or null
 *
 * Only fields the entry carries are returned; modelCosts falls back to its own
 * rules for the rest. The values are untrusted (a third-party file): anything
 * that is not a finite non-negative number is ignored.
 */
function _extras(entry) {
    const tiers = {};
    for (const [tier, suffix] of [['batch', '_batches'], ['flex', '_flex'], ['priority', '_priority']]) {
        const input = _perM(entry, `input_cost_per_token${suffix}`);
        const output = _perM(entry, `output_cost_per_token${suffix}`);
        if (input === undefined || output === undefined) continue;
        const cacheRead = _perM(entry, `cache_read_input_token_cost${suffix}`);
        tiers[tier] = cacheRead === undefined ? { input, output } : { input, output, cacheRead };
    }
    let longCtx = null;
    for (const field of Object.keys(entry)) {
        const m = /^input_cost_per_token_above_(\d{2,4})k_tokens$/.exec(field);
        if (!m) continue;
        const threshold = Number(m[1]) * 1000;
        const input = _perM(entry, field);
        const output = _perM(entry, `output_cost_per_token_above_${m[1]}k_tokens`);
        if (input === undefined || output === undefined) continue;
        if (longCtx && longCtx.threshold <= threshold) continue; // the lowest threshold applies first
        const cacheRead = _perM(entry, `cache_read_input_token_cost_above_${m[1]}k_tokens`);
        longCtx = cacheRead === undefined ? { threshold, input, output } : { threshold, input, output, cacheRead };
    }
    return { tiers, longCtx };
}

/**
 * getModelPricing plus what it does not carry: where the rate came from
 * (`source`: 'community' data or our own 'repo' snapshot), the data key it was
 * read from, and the tier / long-context rates when the data has them.
 * @returns {{ input: number, output: number, cacheRead: number, source: string, key: string|null,
 *             tiers: object, longCtx: object|null } | null}
 */
function getModelPricingDetail(modelId, providerType) {
    if (!modelId) return null;
    const hit = _cachedPricing ? _findEntry(modelId, providerType) : null;
    if (hit) return { ..._extract(hit.entry), source: 'community', key: hit.key, ..._extras(hit.entry) };
    const fallback = _staticFallback(modelId);
    return fallback ? { ...fallback, source: 'repo', key: null, tiers: {}, longCtx: null } : null;
}

/**
 * Our own snapshot of a model's list price, for ids the community database has
 * not picked up yet. Case-insensitive because model ids arrive from admin
 * config and provider listings alike.
 */
function _staticFallback(modelId) {
    const direct = FALLBACK_PRICING[modelId];
    if (direct) return direct;
    const lower = String(modelId).toLowerCase();
    for (const [key, val] of Object.entries(FALLBACK_PRICING)) {
        if (key.toLowerCase() === lower) return val;
    }
    return null;
}

/**
 * Look up one exact key in the pricing database — no prefix guessing, no fuzzy
 * tail match. For a model whose canonical key is known (see
 * providers/scalewayModels.scalewayPricingKey), this is the only lookup that
 * cannot silently return a different host's rate for the same open weights.
 *
 * @param {string} key - e.g. "scaleway/qwen/qwen3.6-35b-a3b"
 * @returns {{ input: number, output: number, cacheRead: number } | null}
 */
function getPricingByKey(key) {
    if (!key || !_cachedPricing) return null;
    const entry = _cachedPricing[key];
    if (!entry || (entry.input_cost_per_token == null && entry.output_cost_per_token == null)) return null;
    return {
        input: (entry.input_cost_per_token || 0) * 1_000_000,
        output: (entry.output_cost_per_token || 0) * 1_000_000,
        cacheRead: (entry.cache_read_input_token_cost || 0) * 1_000_000,
    };
}

/**
 * Get all pricing data converted to our format (per 1M tokens).
 * Used by the config UI to show full pricing list.
 * @returns {Object} Map of modelId → { input, output, provider }
 */
function getAllModelPricing() {
    if (!_cachedPricing) return {};

    const result = {};
    for (const [key, entry] of Object.entries(_cachedPricing)) {
        if (entry.input_cost_per_token == null && entry.output_cost_per_token == null) continue;

        // Extract bare model ID (remove provider prefix)
        const slashIdx = key.indexOf('/');
        const modelId = slashIdx >= 0 ? key.substring(slashIdx + 1) : key;

        // Skip if we already have this model (prefer the first/unprefixed match)
        if (result[modelId]) continue;

        result[modelId] = {
            input: (entry.input_cost_per_token || 0) * 1_000_000,
            output: (entry.output_cost_per_token || 0) * 1_000_000,
            cacheRead: (entry.cache_read_input_token_cost || 0) * 1_000_000,
            provider: entry.litellm_provider || null,
        };
    }

    return result;
}

/**
 * Every model we have a price for, as donors for the estimate of a model nothing
 * prices (unknownModelRate.js): our own OpenAI and Anthropic snapshots first,
 * then the community data on top (as in getModelPricing, community wins).
 * Each entry names the provider that sells it (our adapter vocabulary: claude,
 * openai, azure, google, google-vertex, mistral, scaleway; null for any other
 * host), so a donor is only ever taken from the provider the unknown model belongs to.
 * Built on a Map: a key from the (third-party) data file can never touch a prototype.
 *
 * @returns {Array<{ id: string, vendor: string|null, input: number, output: number, cacheRead: number|null, currency: string, source: string }>}
 */
function listKnownPricing() {
    const byId = new Map();
    const put = (id, rates, vendor, currency, source) => {
        if (typeof id !== 'string' || !id) return;
        byId.set(id, { id, vendor, input: rates.input, output: rates.output, cacheRead: rates.cacheRead ?? null, currency, source });
    };
    for (const [id, r] of Object.entries(listPricedModels())) put(id, r, 'openai', 'USD', 'repo');
    for (const [id, r] of Object.entries(listClaudePricedModels())) put(id, r, 'claude', 'USD', 'repo');
    for (const [id, r] of Object.entries(getAllModelPricing())) {
        if (typeof r?.input !== 'number' || typeof r?.output !== 'number') continue;
        const vendor = vendorOfCommunityProvider(r.provider);
        put(id, r, vendor, vendor === 'scaleway' ? 'EUR' : 'USD', 'litellm');
    }
    return [...byId.values()];
}

/** The adapter type behind a community `litellm_provider` string, or null for any other host. */
function vendorOfCommunityProvider(p) {
    const s = String(p || '').toLowerCase();
    if (s === 'anthropic') return 'claude';
    if (s === 'openai' || s === 'text-completion-openai') return 'openai';
    if (s === 'azure') return 'azure';
    if (s === 'gemini') return 'google';
    if (s.startsWith('vertex_ai')) return 'google-vertex';
    if (s === 'mistral') return 'mistral';
    if (s === 'scaleway') return 'scaleway';
    return null;
}

/**
 * Initialize pricing on startup (non-blocking).
 */
function initPricing() {
    fetchAllPricing().catch(e => log.error('[PricingService] Init failed:', e.message));
}

module.exports = {
    fetchAllPricing,
    getModelPricing,
    getModelPricingDetail,
    getPricingByKey,
    getAllModelPricing,
    listKnownPricing,
    // Legacy aliases (backwards compat)
    getLiteLLMCost: getModelPricing,
    getAllLiteLLMCosts: getAllModelPricing,
    initPricing,
};
