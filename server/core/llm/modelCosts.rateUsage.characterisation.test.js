// @typecheck
/**
 * Characterisation (golden) test for modelCosts.rateUsage: the whole rated
 * row (cost, its input/output split, rates, multipliers, prices, basis,
 * source, notes) for a fixed set of calls against fixed catalogue cards,
 * community prices and admin overrides. Every branch that changes a number or
 * a note is in a case: the cache-write split and its remainder, the two token
 * conventions, the long-context tier, tier pricing by card, by the source's
 * tier rate, by multiplier and by default, geo and regional factors, flat
 * cards, an invalid card, the unknown-model estimates and the self-hosted
 * zero.
 *
 * The catalogue index and the pricing code are the real ones; the config
 * store and the community pricing data are stubbed (as in the other
 * modelCosts tests).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/llm/modelCosts.rateUsage.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useConfigRows } = require('../../testUtils/configRows');
const { loadPricing } = require('../../testUtils/pricingFeed');

const PRICING = {
    'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
    'flex-capable': {
        input: 2, output: 8, cacheRead: 0.5,
        tiers: { flex: { input: 1, output: 4, cacheRead: 0.25 }, priority: { input: 3.5, output: 14 } },
    },
    // The flex tier's own cached-read rate differs from the scaled list rate.
    'flex-own-cache': { input: 2, output: 8, cacheRead: 0.5, tiers: { flex: { input: 1, output: 4, cacheRead: 0.4 } } },
    'long-flex': {
        input: 3, output: 15, cacheRead: 0.3,
        longCtx: { threshold: 200000, input: 6, output: 22.5, cacheRead: 0.6 },
        tiers: { flex: { input: 1.5, output: 7.5, cacheRead: 0.2 } },
    },
    'zero-input-tiers': { input: 0, output: 8, tiers: { flex: { input: 1, output: 4 } } },
    'long-capable': {
        input: 3, output: 15, cacheRead: 0.3,
        longCtx: { threshold: 200000, input: 6, output: 22.5, cacheRead: 0.6 },
    },
};

const config = useConfigRows();
const OVERRIDES_KEY = 'model_cost_overrides';
test.before(() => loadPricing(PRICING));
test.after(config.restore);

const catalog = require('../../stores/lib/priceCatalog');
const costs = require('./modelCosts');
const { registerLocalModel, _resetLocalModelRegistry } = require('../providers/localModels');
const { registerEuServedModel, _resetEuServedRegistry } = require('../providers/openaiModels');

const GOLDEN = path.join(__dirname, 'modelCosts.rateUsage.characterisation.golden.json');
const AT = '2026-10-01T00:00:00.000Z';

function card(over = {}) {
    return {
        provider: 'claude', model_id: 'claude-cat-1', tier: 'standard', currency: 'USD',
        input: 5, output: 25, cache_read: 0.5, cache_write_5m: null, cache_write_1h: null,
        long_ctx_threshold: null, long_ctx_rates: null, multipliers: null,
        source: 'anthropic-pricing', catalog_version: '2026-09-01',
        valid_from: '2026-01-01T00:00:00.000Z', valid_to: null,
        ...over,
    };
}

const CARDS = [
    card({}),
    card({ model_id: 'claude-writes', cache_write_5m: 6.25, cache_write_1h: 10 }),
    card({ model_id: 'claude-flat-writes', cache_write_5m: 8, cache_write_1h: 8 }),
    card({ model_id: 'claude-long', long_ctx_threshold: 100000, long_ctx_rates: { input: 10, cache_write_1h: 30 } }),
    card({ model_id: 'claude-long-zero', input: 0, output: 1, long_ctx_threshold: 10, long_ctx_rates: { input: 4 } }),
    card({ model_id: 'claude-mult', multipliers: { batch: 0.4, priority: 1.75, geo: { us: 1.1 }, regional: 1.3 } }),
    card({ model_id: 'claude-mult', tier: 'flex', input: 1, output: 3, cache_read: 0.1, source: 'anthropic-flex', catalog_version: 'flex-1' }),
    card({ provider: 'openai', model_id: 'gpt-cat-eu', input: 10, output: 20, cache_read: null, multipliers: { regional: 1.2 } }),
    card({ provider: 'openai', model_id: 'gpt-cat-plain', input: 10, output: 20, cache_read: null }),
    card({ model_id: 'claude-bad-catalog', input: -1, output: 5 }),
];

const OVERRIDES = {
    'override-model': { input: 1, output: 2 },
    'override-nan': { input: NaN, output: 1 },
    'override-inf': { input: 1, output: Infinity },
};

const M = 1_000_000;
const CASES = {
    plainNoTokens: { model: 'claude-cat-1', timestamp: AT },
    plainLegacyAt: { model: 'claude-cat-1', at: AT, prompt_tokens: M, completion_tokens: M / 2 },
    anthropicConvention: { model: 'claude-cat-1', timestamp: AT, prompt_tokens: M, cached_tokens: M, cache_creation_tokens: M / 2, completion_tokens: 100, prompt_includes_cache: false },
    anthropicByName: { model: 'claude-cat-1', timestamp: AT, prompt_tokens: M, cached_tokens: M / 4, cache_creation_tokens: M / 4 },
    openaiByName: { model: 'gpt-4o', timestamp: AT, prompt_tokens: M, cached_tokens: M / 4, completion_tokens: M },
    cachedAboveTotal: { model: 'gpt-4o', timestamp: AT, prompt_tokens: 100, cached_tokens: 500, prompt_includes_cache: true },
    garbageTokens: { model: 'gpt-4o', timestamp: AT, prompt_tokens: -5, completion_tokens: 'many', cached_tokens: NaN, cache_creation_tokens: Infinity },
    writeOnly1h: { model: 'claude-writes', timestamp: AT, cache_creation_tokens: M, cache_ttl: '1h', prompt_includes_cache: false },
    writeOnly5m: { model: 'claude-writes', timestamp: AT, cache_creation_tokens: M, prompt_includes_cache: false },
    splitWithRemainder1h: { model: 'claude-writes', timestamp: AT, cache_creation_tokens: 3 * M, cache_creation_5m_tokens: M, cache_creation_1h_tokens: M / 2, cache_ttl: '1h', prompt_includes_cache: false },
    splitWithRemainder5m: { model: 'claude-writes', timestamp: AT, cache_creation_tokens: 3 * M, cache_creation_5m_tokens: M, cache_creation_1h_tokens: M / 2, prompt_includes_cache: false },
    splitAboveTotal: { model: 'claude-writes', timestamp: AT, cache_creation_tokens: 10, cache_creation_5m_tokens: M, cache_creation_1h_tokens: M, prompt_includes_cache: false },
    ttlAssumedDiffering: { model: 'claude-writes', timestamp: AT, cache_creation_tokens: M, cache_creation_ttl_assumed: true, prompt_includes_cache: false },
    ttlAssumedEqualRates: { model: 'claude-flat-writes', timestamp: AT, cache_creation_tokens: M, cache_creation_ttl_assumed: true, prompt_includes_cache: false },
    ttlAssumedNoWrite: { model: 'claude-writes', timestamp: AT, cache_creation_ttl_assumed: true, prompt_tokens: M, prompt_includes_cache: false },
    defaultWriteMultipliers: { model: 'claude-cat-1', timestamp: AT, cache_creation_5m_tokens: M, cache_creation_1h_tokens: M, prompt_includes_cache: false },
    longAbove: { model: 'claude-long', timestamp: AT, prompt_tokens: 90000, cached_tokens: 20000, cache_creation_1h_tokens: 1000, completion_tokens: 1000, prompt_includes_cache: false },
    longBelow: { model: 'claude-long', timestamp: AT, prompt_tokens: 50000, completion_tokens: 1000, prompt_includes_cache: false },
    longZeroBaseInput: { model: 'claude-long-zero', timestamp: AT, prompt_tokens: 100, cached_tokens: 10, prompt_includes_cache: false },
    longCommunity: { model: 'long-capable', timestamp: AT, prompt_tokens: 300000, cached_tokens: 100000, completion_tokens: 1000, prompt_includes_cache: true },
    longCommunityFlex: { model: 'long-capable', timestamp: AT, service_tier: 'flex', prompt_tokens: 300000, completion_tokens: 1000, prompt_includes_cache: true },
    tierCardPriced: { model: 'claude-mult', timestamp: AT, service_tier: 'flex', prompt_tokens: M, completion_tokens: M, prompt_includes_cache: false },
    tierCardMultiplier: { model: 'claude-mult', timestamp: AT, service_tier: 'batch', prompt_tokens: M, completion_tokens: M, cached_tokens: M, prompt_includes_cache: false },
    tierPriorityMultiplier: { model: 'claude-mult', timestamp: AT, service_tier: 'priority', prompt_tokens: M, prompt_includes_cache: false },
    tierSourceRates: { model: 'flex-capable', timestamp: AT, service_tier: 'flex', prompt_tokens: M, cached_tokens: M / 2, completion_tokens: M, prompt_includes_cache: true },
    tierSourceOwnCacheRead: { model: 'flex-own-cache', timestamp: AT, service_tier: 'flex', prompt_tokens: M, cached_tokens: M / 2, completion_tokens: M, prompt_includes_cache: true },
    tierSourceOwnCacheReadOnly: { model: 'flex-own-cache', timestamp: AT, service_tier: 'flex', cached_tokens: M, prompt_includes_cache: false },
    longTierOwnCacheRead: { model: 'long-flex', timestamp: AT, service_tier: 'flex', prompt_tokens: 300000, cached_tokens: 100000, completion_tokens: 1000, prompt_includes_cache: true },
    shortTierOwnCacheRead: { model: 'long-flex', timestamp: AT, service_tier: 'flex', prompt_tokens: 100000, cached_tokens: 50000, completion_tokens: 1000, prompt_includes_cache: true },
    tierSourceRatesNoCacheRead: { model: 'flex-capable', timestamp: AT, service_tier: 'priority', prompt_tokens: M, cached_tokens: M / 2, completion_tokens: M, prompt_includes_cache: true },
    tierSourceZeroInput: { model: 'zero-input-tiers', timestamp: AT, service_tier: 'flex', prompt_tokens: M, completion_tokens: M, prompt_includes_cache: true },
    tierDefaultMultiplier: { model: 'gpt-4o', timestamp: AT, service_tier: 'batch', prompt_tokens: M, completion_tokens: M },
    tierUnknownMultiplier: { model: 'gpt-4o', timestamp: AT, service_tier: 'priority', prompt_tokens: M, completion_tokens: M },
    tierVertexTraffic: { model: 'gpt-4o', timestamp: AT, traffic_type: 'ON_DEMAND_FLEX', prompt_tokens: M },
    tierUnrecognised: { model: 'claude-cat-1', timestamp: AT, service_tier: 'scale', prompt_tokens: M, prompt_includes_cache: false },
    geoKnown: { model: 'claude-mult', timestamp: AT, inference_geo: 'US', prompt_tokens: M, completion_tokens: M, prompt_includes_cache: false },
    geoUnknown: { model: 'claude-cat-1', timestamp: AT, inference_geo: 'eu', prompt_tokens: M, prompt_includes_cache: false },
    geoGlobal: { model: 'claude-cat-1', timestamp: AT, inference_geo: 'global', prompt_tokens: M, prompt_includes_cache: false },
    overrideFlat: { model: 'override-model', timestamp: AT, service_tier: 'priority', inference_geo: 'us', prompt_tokens: M, completion_tokens: M },
    overrideNaN: { model: 'override-nan', timestamp: AT, prompt_tokens: M, completion_tokens: M },
    overrideInfinity: { model: 'override-inf', timestamp: AT, prompt_tokens: M, completion_tokens: M },
    invalidCatalogCard: { model: 'claude-bad-catalog', timestamp: AT, prompt_tokens: M, completion_tokens: M, prompt_includes_cache: false },
    regionalCatalogFactor: { model: 'gpt-cat-eu', timestamp: AT, prompt_tokens: M, prompt_includes_cache: true },
    regionalBuiltIn: { model: 'gpt-cat-plain', timestamp: AT, prompt_tokens: M, prompt_includes_cache: true },
    regionalMistral: { model: 'mistral-large-latest', provider: 'mistral', timestamp: AT, prompt_tokens: M, completion_tokens: M },
    unknownFamily: { model: 'claude-sonnet-4-9', timestamp: AT, prompt_tokens: M, completion_tokens: M },
    unknownVariantWords: { model: 'gpt-4o-ultra-preview', timestamp: AT, prompt_tokens: M, completion_tokens: M },
    unknownProvider: { model: 'claude-mystery', provider: 'claude', timestamp: AT, prompt_tokens: M, completion_tokens: M },
    unknownNoData: { model: 'totally-new-model', timestamp: AT, prompt_tokens: M, completion_tokens: M },
    unknownNoModel: { timestamp: AT, prompt_tokens: 10 },
    unknownAzureUnmapped: { model: 'prod-chat-unmapped', provider: 'azure', timestamp: AT, prompt_tokens: M },
    localModel: { model: 'gpt-oss-120b', provider: 'scaleway', timestamp: AT, prompt_tokens: M, completion_tokens: M },
};

/**
 * An estimated row borrows its rates from donors in the repo's own price
 * snapshots, which move whenever a model is added there. What rateUsage
 * decides for such a row is pinned instead: the level of the
 * estimate, basis, notes, multipliers, and that the cost is the tokens times
 * the borrowed rates.
 */
function pinnable(entry, row) {
    if (!String(row.source).startsWith('estimate:')) return row;
    const expected = ((entry.prompt_tokens || 0) / M) * row.rates.input + ((entry.completion_tokens || 0) / M) * row.rates.output;
    return {
        source: row.source.split(':').slice(0, 2).join(':'),
        cost_basis: row.cost_basis, currency: row.currency, notes: row.notes, multiplier: row.multiplier,
        long_context: row.long_context, tier: row.tier, provider: row.provider, model: row.model,
        costFromRates: Math.abs(row.cost - expected) < 1e-9, positive: row.cost > 0,
        splitAddsUp: Math.abs(row.input_cost + row.output_cost - row.cost) < 1e-9,
    };
}

let _collected = null;
async function collect() {
    if (_collected) return _collected;
    catalog.clear();
    catalog.setRows(CARDS);
    config.rows[OVERRIDES_KEY] = OVERRIDES;
    await costs.refreshCustomOverrides();
    _resetLocalModelRegistry();
    _resetEuServedRegistry();
    registerLocalModel('gpt-oss-120b');
    registerEuServedModel('gpt-cat-eu');
    registerEuServedModel('gpt-cat-plain');
    const out = {};
    for (const [key, entry] of Object.entries(CASES)) out[key] = pinnable(entry, costs.rateUsage(entry));
    _collected = JSON.parse(JSON.stringify(out));
    return _collected;
}

function loadOrWrite(actual) {
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
}

for (const key of Object.keys(CASES)) {
    test(`golden: ${key}`, async () => {
        const actual = await collect();
        const golden = loadOrWrite(actual);
        assert.deepEqual(actual[key], golden[key]);
    });
}
