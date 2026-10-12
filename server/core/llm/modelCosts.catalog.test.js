/**
 * DB-free tests — modelCosts rates a call with the price card in force AT THE
 * CALL'S TIMESTAMP, and says how it got the number.
 *
 * The in-memory catalogue index (stores/lib/priceCatalog.js) is the real one; only
 * the config store and the community pricing data are stubbed. Proven:
 *
 *   - time-correctness: a card with a future valid_from never touches a call made
 *     before it, a call made after it uses it, and the same call rated again later
 *     gives the same answer (old rows are not re-priced when a newer card lands);
 *   - precedence: admin override -> local (zero, before any lookup) -> catalogue ->
 *     provider tariffs -> community data; nothing changes without catalogue rows;
 *   - billing facts: batch / flex / priority tiers, Anthropic inference_geo,
 *     long-context tier on the whole request, 5m and 1h cache writes priced per
 *     part, regional uplift;
 *   - the evidence: rates used, source, catalog_version, cost_basis, currency;
 *   - the number-only API (computeCost / computeCostSplit / getModelCost) keeps
 *     its old numbers and shapes.
 *
 * Run: cd server && node --test core/llm/modelCosts.catalog.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const PRICING = {
    'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
    'flex-capable': { input: 2, output: 8, cacheRead: 0.5 },
    'long-capable': { input: 3, output: 15, cacheRead: 0.3 },
    'expensive-frontier-model': { input: 15, output: 120 },
};
const DETAIL = {
    'flex-capable': {
        ...PRICING['flex-capable'], source: 'community', key: 'flex-capable',
        tiers: { flex: { input: 1, output: 4, cacheRead: 0.25 }, priority: { input: 3.5, output: 14 } }, longCtx: null,
    },
    'long-capable': {
        ...PRICING['long-capable'], source: 'community', key: 'long-capable',
        tiers: {}, longCtx: { threshold: 200000, input: 6, output: 22.5, cacheRead: 0.6 },
    },
};

const overrides = { value: null };
const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: async () => overrides.value,
        mutateConfig: async (_k, fn) => { overrides.value = fn(overrides.value); return overrides.value; },
        setConfig: () => { },
    },
    './pricingService': {
        getModelPricing: (name) => PRICING[name] || null,
        getModelPricingDetail: (name) => DETAIL[name] || (PRICING[name] ? { ...PRICING[name], source: 'community', key: name, tiers: {}, longCtx: null } : null),
        getPricingByKey: () => null,
        initPricing: () => { },
        getAllModelPricing: () => PRICING,
    },
});

const catalog = require('../../stores/lib/priceCatalog');
const costs = require('./modelCosts');
const { registerLocalModel, _resetLocalModelRegistry } = require('../providers/localModels');
const { registerScalewayModel, _resetScalewayModelRegistry } = require('../providers/scalewayModels');
const { registerEuServedModel, _resetEuServedRegistry } = require('../providers/openaiModels');

test.after(() => restore());
test.beforeEach(async () => {
    catalog.clear();
    overrides.value = null;
    await costs.refreshCustomOverrides(); // drop the snapshot a previous test's override left behind
    _resetLocalModelRegistry();
    _resetScalewayModelRegistry();
    _resetEuServedRegistry();
});

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} — got ${a}, expected ${b}`);

function card(over = {}) {
    return {
        provider: 'claude', model_id: 'claude-cat-1', tier: 'standard', currency: 'USD',
        input: 5, output: 25, cache_read: 0.5, cache_write_5m: null, cache_write_1h: null,
        long_ctx_threshold: null, long_ctx_rates: null, multipliers: null,
        source: 'anthropic-pricing', catalog_version: '2026-09-01',
        valid_from: iso(NOW - 60 * DAY), valid_to: null,
        ...over,
    };
}

// ─── time-correctness ────────────────────────────────────────────────────────

test('KEY: a card with a future valid_from does not affect a call made before it', () => {
    const stepUp = NOW + 30 * DAY;
    catalog.setRows([
        card({ input: 5, output: 25, catalog_version: 'v-old', valid_from: iso(NOW - 60 * DAY) }),
        card({ input: 10, output: 50, catalog_version: 'v-future', valid_from: iso(stepUp) }),
    ]);
    const usage = { model: 'claude-cat-1', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };

    const today = costs.rateUsage({ ...usage, timestamp: iso(NOW) });
    near(today.cost, 30, 'a call made today pays the card in force today');
    assert.strictEqual(today.catalog_version, 'v-old');

    const lastMonth = costs.rateUsage({ ...usage, timestamp: iso(NOW - 20 * DAY) });
    near(lastMonth.cost, 30, 'history keeps its own price');

    const afterStepUp = costs.rateUsage({ ...usage, timestamp: iso(stepUp + 1000) });
    near(afterStepUp.cost, 60, 'a call after the step-up pays the new card');
    assert.strictEqual(afterStepUp.catalog_version, 'v-future');
    assert.strictEqual(afterStepUp.valid_from, iso(stepUp));

    // Rating the same past call again, later, with the future card now loaded,
    // gives the same answer: nothing re-prices history.
    near(costs.rateUsage({ ...usage, timestamp: iso(NOW - 20 * DAY) }).cost, 30, 'unchanged on re-rating');
});

test('a card added later with an earlier-effective date does not move calls before it', () => {
    catalog.setRows([card({ input: 5, output: 25, valid_from: iso(NOW - 60 * DAY) })]);
    const usage = { model: 'claude-cat-1', prompt_tokens: 1_000_000 };
    const before = costs.rateUsage({ ...usage, timestamp: iso(NOW - 10 * DAY) }).cost;
    // the importer detects a change today and publishes it effective from yesterday
    catalog.setRows([
        card({ input: 5, output: 25, valid_from: iso(NOW - 60 * DAY) }),
        card({ input: 8, output: 40, catalog_version: 'v2', valid_from: iso(NOW - 1 * DAY) }),
    ]);
    near(costs.rateUsage({ ...usage, timestamp: iso(NOW - 10 * DAY) }).cost, before, 'an older call still pays the old card');
    near(costs.rateUsage({ ...usage, timestamp: iso(NOW) }).cost, 8, 'a newer call pays the new card');
});

test('an expired card (valid_to) stops applying and the model falls back to the other sources', () => {
    catalog.setRows([card({ model_id: 'gpt-4o', provider: 'openai', input: 1, output: 1, valid_from: iso(NOW - 30 * DAY), valid_to: iso(NOW - 10 * DAY) })]);
    const during = costs.rateUsage({ model: 'gpt-4o', prompt_tokens: 1_000_000, timestamp: iso(NOW - 20 * DAY) });
    near(during.cost, 1, 'promo card while it lasted');
    assert.strictEqual(during.source, 'anthropic-pricing');
    const after = costs.rateUsage({ model: 'gpt-4o', prompt_tokens: 1_000_000, timestamp: iso(NOW) });
    near(after.cost, 2.5, 'afterwards the community rate');
    assert.strictEqual(after.source, 'litellm');
});

// ─── precedence ──────────────────────────────────────────────────────────────

test('without catalogue rows the community data prices the call, as before', () => {
    const r = costs.rateUsage({ model: 'gpt-4o', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    near(r.cost, 12.5, 'community rate');
    assert.strictEqual(r.source, 'litellm');
    assert.strictEqual(r.cost_basis, 'list');
    assert.strictEqual(r.catalog_version, null);
    assert.strictEqual(r.currency, 'USD');
});

test('a catalogue card beats the community data for the same model', () => {
    catalog.setRows([card({ provider: 'openai', model_id: 'gpt-4o', input: 2, output: 8, source: 'openai-pricing', catalog_version: 'c1' })]);
    const r = costs.rateUsage({ model: 'gpt-4o', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    near(r.cost, 10, 'catalogue rate');
    assert.strictEqual(r.source, 'openai-pricing');
    assert.strictEqual(r.cost_basis, 'exact');
    assert.strictEqual(r.catalog_version, 'c1');
});

test('an admin override beats the catalogue', async () => {
    catalog.setRows([card({ provider: 'openai', model_id: 'gpt-4o', input: 2, output: 8 })]);
    await costs.setModelCost('gpt-4o', 1, 1);
    const r = costs.rateUsage({ model: 'gpt-4o', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    near(r.cost, 2, 'the override');
    assert.strictEqual(r.source, 'override');
    assert.strictEqual(r.cost_basis, 'exact');
});

test('a self-hosted model is zero strictly before the catalogue, whatever the catalogue says', () => {
    registerLocalModel('gpt-oss-120b');
    // even a (hostile or mistaken) card for the very same id must not price local hardware
    catalog.setRows([card({ provider: 'scaleway', model_id: 'gpt-oss-120b', input: 9, output: 9 }), card({ provider: 'openai', model_id: 'gpt-oss-120b', input: 9, output: 9 })]);
    const r = costs.rateUsage({ model: 'gpt-oss-120b', provider: 'scaleway', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    assert.strictEqual(r.cost, 0);
    assert.strictEqual(r.cost_basis, 'local');
    assert.strictEqual(r.source, 'local');
    assert.strictEqual(r.price_input, 0);
    assert.deepStrictEqual(costs.getModelCost('gpt-oss-120b'), { input: 0, output: 0, cacheRead: 0 });
});

test('an unknown id is only priced from the catalogue when ONE provider holds a card for it', () => {
    catalog.setRows([card({ provider: 'openai', model_id: 'mystery-1', input: 1, output: 1 })]);
    near(costs.rateUsage({ model: 'mystery-1', prompt_tokens: 1_000_000 }).cost, 1, 'unambiguous');
    catalog.setRows([card({ provider: 'openai', model_id: 'mystery-1', input: 1, output: 1 }), card({ provider: 'scaleway', model_id: 'mystery-1', input: 7, output: 7, currency: 'EUR' })]);
    const r = costs.rateUsage({ model: 'mystery-1', prompt_tokens: 1_000_000 });
    assert.strictEqual(r.cost_basis, 'unknown', 'two hosts of the same weights: never pick one at random');
});

test('a provider hint picks that provider\'s card; the Scaleway card is EUR, never round-tripped', () => {
    catalog.setRows([
        card({ provider: 'scaleway', model_id: 'gpt-oss-120b', currency: 'EUR', input: 0.15, output: 0.6, source: 'scaleway-product-catalog' }),
        card({ provider: 'openai', model_id: 'gpt-oss-120b', input: 0.2, output: 0.8, source: 'litellm' }),
    ]);
    registerScalewayModel('gpt-oss-120b');
    const sw = costs.rateUsage({ model: 'gpt-oss-120b', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    assert.strictEqual(sw.currency, 'EUR');
    near(sw.cost, 0.75, 'Scaleway card via the served-model registry');
    const hinted = costs.rateUsage({ model: 'gpt-oss-120b', provider: 'openai', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    assert.strictEqual(hinted.currency, 'USD');
    near(hinted.cost, 1.0, 'explicit provider wins');
    assert.strictEqual(hinted.cost_basis, 'list', 'a litellm-sourced card is a list price');
});

test('the legacy Scaleway tariff (repo list price) is EUR too, so a EUR plan is not converted through USD', () => {
    registerScalewayModel('glm-5.2');
    const r = costs.rateUsage({ model: 'glm-5.2', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    assert.strictEqual(r.currency, 'EUR');
    near(r.cost, 1.8 + 5.5, 'same number as before: only the label is new');
    assert.strictEqual(r.source, 'repo:scaleway');
});

test('Azure: a deployment name resolves to its model and falls back to the vendor card, flagged as list', () => {
    const { setAzureDeployments } = require('../providers/azureDeployments');
    setAzureDeployments([{ deployment: 'prod-chat', model: 'gpt-4o' }]);
    try {
        catalog.setRows([card({ provider: 'openai', model_id: 'gpt-4o', input: 2, output: 8, source: 'openai-pricing' })]);
        const viaFamily = costs.rateUsage({ model: 'prod-chat', prompt_tokens: 1_000_000 });
        near(viaFamily.cost, 2, 'priced as the model behind the deployment');
        assert.strictEqual(viaFamily.cost_basis, 'list', 'no Azure card: the OpenAI list price, not an exact Azure one');
        catalog.setRows([
            card({ provider: 'openai', model_id: 'gpt-4o', input: 2, output: 8 }),
            card({ provider: 'azure', model_id: 'gpt-4o', input: 2.2, output: 8.8, source: 'azure-retail-prices' }),
        ]);
        const own = costs.rateUsage({ model: 'prod-chat', prompt_tokens: 1_000_000 });
        near(own.cost, 2.2, 'the Azure card when there is one');
        assert.strictEqual(own.cost_basis, 'exact');
    } finally {
        setAzureDeployments([]);
    }
});

// ─── billing facts ───────────────────────────────────────────────────────────

test('tier: a catalogue multiplier prices a batch call; the standard tier is untouched', () => {
    catalog.setRows([card({ multipliers: { batch: 0.5, priority: 2 } })]);
    const std = costs.rateUsage({ model: 'claude-cat-1', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, service_tier: 'standard' });
    near(std.cost, 30, 'standard');
    const batch = costs.rateUsage({ model: 'claude-cat-1', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, service_tier: 'batch' });
    near(batch.cost, 15, 'batch at the catalogue multiplier');
    assert.strictEqual(batch.tier, 'batch');
    assert.strictEqual(batch.cost_basis, 'exact');
    const prio = costs.rateUsage({ model: 'claude-cat-1', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, service_tier: 'priority' });
    near(prio.cost, 60, 'priority at the catalogue multiplier');
    near(prio.price_input, 10, 'the rate actually charged is stored, after the multiplier');
});

test('tier: a tier-specific catalogue card is used as is (no second multiplier)', () => {
    catalog.setRows([
        card({ multipliers: { flex: 0.5 } }),
        card({ tier: 'flex', input: 2, output: 10 }),
    ]);
    const r = costs.rateUsage({ model: 'claude-cat-1', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, service_tier: 'flex' });
    near(r.cost, 12, 'the flex card, not flex-of-standard');
});

test('tier: community data with its own flex rate uses it; batch/priority without data are flagged estimated', () => {
    const flex = costs.rateUsage({ model: 'flex-capable', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, service_tier: 'flex' });
    near(flex.cost, 5, 'LiteLLM flex rates: 1 + 4');
    assert.strictEqual(flex.cost_basis, 'list');
    const batch = costs.rateUsage({ model: 'gpt-4o', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, service_tier: 'batch' });
    near(batch.cost, 6.25, 'documented half-price default');
    assert.strictEqual(batch.cost_basis, 'estimated');
    assert.ok(batch.notes.includes('tier_batch_default_multiplier'));
    const prio = costs.rateUsage({ model: 'gpt-4o', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, service_tier: 'priority' });
    near(prio.cost, 12.5, 'no invented priority premium');
    assert.strictEqual(prio.cost_basis, 'estimated');
});

test('tier: Vertex traffic types map to tiers; committed capacity is flagged, not guessed', () => {
    catalog.setRows([card({ multipliers: { flex: 0.5, priority: 1.8 } })]);
    const q = (extra) => costs.rateUsage({ model: 'claude-cat-1', prompt_tokens: 1_000_000, ...extra });
    near(q({ traffic_type: 'on_demand_priority' }).cost, 9, 'priority via traffic type');
    near(q({ traffic_type: 'on_demand_flex' }).cost, 2.5, 'flex via traffic type');
    const pt = q({ service_tier: 'scale' });
    near(pt.cost, 5, 'unrecognised tier priced as standard');
    assert.strictEqual(pt.cost_basis, 'estimated');
    assert.ok(pt.notes.includes('tier_unrecognised'));
});

test('an admin override stays flat across tiers (it is the price the customer decided on)', async () => {
    await costs.setModelCost('gpt-4o', 1, 1);
    const r = costs.rateUsage({ model: 'gpt-4o', prompt_tokens: 1_000_000, service_tier: 'batch' });
    near(r.cost, 1, 'no batch discount on top of an explicit price');
    assert.strictEqual(r.cost_basis, 'exact');
});

test('inference_geo: the catalogue multiplier applies to every token category; global is neutral', () => {
    catalog.setRows([card({ multipliers: { geo: { us: 1.1 } } })]);
    const base = { model: 'claude-cat-1', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, cached_tokens: 1_000_000, prompt_includes_cache: false };
    const g = costs.rateUsage({ ...base, inference_geo: 'global' });
    near(g.cost, 5 + 25 + 0.5, 'global');
    const us = costs.rateUsage({ ...base, inference_geo: 'us' });
    near(us.cost, (5 + 25 + 0.5) * 1.1, 'us');
    assert.strictEqual(us.cost_basis, 'exact');
    near(us.multiplier.geo, 1.1);
    const eu = costs.rateUsage({ ...base, inference_geo: 'eu' });
    near(eu.cost, 30.5, 'no card for eu: list price');
    assert.strictEqual(eu.cost_basis, 'estimated', '... and it says it could not be sure');
});

test('long context: above the threshold the whole request is billed at the long-context rates', () => {
    catalog.setRows([card({ long_ctx_threshold: 200_000, long_ctx_rates: { input: 10, output: 37.5 } })]);
    const q = (promptTokens) => costs.rateUsage({ model: 'claude-cat-1', prompt_tokens: promptTokens, completion_tokens: 1_000_000, prompt_includes_cache: false });
    const short = q(200_000);
    near(short.cost, 0.2 * 5 + 25, 'at the threshold is NOT above it');
    assert.strictEqual(short.long_context, false);
    const long = q(200_001);
    near(long.cost, 0.200001 * 10 + 37.5, 'one token above: the whole request at the long rates');
    assert.strictEqual(long.long_context, true);
});

test('long context counts cached and cache-write tokens of an Anthropic call toward the threshold', () => {
    catalog.setRows([card({ long_ctx_threshold: 200_000, long_ctx_rates: { input: 10, output: 37.5 } })]);
    const r = costs.rateUsage({
        model: 'claude-cat-1', prompt_tokens: 50_000, cached_tokens: 160_000, completion_tokens: 0, prompt_includes_cache: false,
    });
    assert.strictEqual(r.long_context, true, '50k uncached + 160k cache read = 210k input');
    // cache read scales with the input ratio (10/5) when the card gives no long cache rate
    near(r.cost, 0.05 * 10 + 0.16 * (0.5 * 2), 'uncached at 10, cache read at 1.0');
});

test('long context from the community data (LiteLLM above_200k fields)', () => {
    const r = costs.rateUsage({ model: 'long-capable', prompt_tokens: 300_000, completion_tokens: 100_000, prompt_includes_cache: true });
    assert.strictEqual(r.long_context, true);
    near(r.cost, 0.3 * 6 + 0.1 * 22.5);
    const short = costs.rateUsage({ model: 'long-capable', prompt_tokens: 100_000, completion_tokens: 100_000, prompt_includes_cache: true });
    near(short.cost, 0.1 * 3 + 0.1 * 15);
});

test('cache writes: the 5m and 1h parts of a mixed write are priced each at their own rate', () => {
    // Anthropic: 5m = 1.25x input, 1h = 2x input; input 3 -> 3.75 and 6.
    const r = costs.rateUsage({
        model: 'claude-sonnet-4-5', prompt_tokens: 0, completion_tokens: 0, prompt_includes_cache: false,
        cache_creation_tokens: 3_000_000, cache_creation_5m_tokens: 1_000_000, cache_creation_1h_tokens: 2_000_000,
    });
    near(r.cost, 1 * 3.75 + 2 * 6, 'each part at its own rate, not all at one dominant TTL');
    near(r.price_cache_write, (1 * 3.75 + 2 * 6) / 3, 'the stored write rate is the token-weighted mean of a mixed write');
    near(r.rates.cache_write_5m, 3.75);
    near(r.rates.cache_write_1h, 6);
});

test('cache writes: a catalogue card gives explicit 5m/1h rates; without a split the legacy TTL decides', () => {
    catalog.setRows([card({ cache_write_5m: 6, cache_write_1h: 10 })]);
    const split = costs.rateUsage({ model: 'claude-cat-1', prompt_includes_cache: false, cache_creation_tokens: 2_000_000, cache_creation_5m_tokens: 1_000_000, cache_creation_1h_tokens: 1_000_000 });
    near(split.cost, 16);
    const legacy5 = costs.rateUsage({ model: 'claude-cat-1', prompt_includes_cache: false, cache_creation_tokens: 1_000_000, cache_ttl: '5m' });
    near(legacy5.cost, 6);
    const legacy1 = costs.rateUsage({ model: 'claude-cat-1', prompt_includes_cache: false, cache_creation_tokens: 1_000_000, cache_ttl: '1h' });
    near(legacy1.cost, 10);
});

test('cache writes: a TTL that was only assumed is priced but the row says estimated', () => {
    const r = costs.rateUsage({
        model: 'claude-sonnet-4-5', prompt_includes_cache: false, cache_creation_tokens: 1_000_000,
        cache_creation_1h_tokens: 1_000_000, cache_creation_ttl_assumed: true,
    });
    near(r.cost, 6);
    assert.strictEqual(r.cost_basis, 'estimated');
    assert.ok(r.notes.includes('cache_ttl_assumed'));
});

test('regional uplift: the catalogue factor replaces the built-in 1.1 only for a model served regionally', () => {
    catalog.setRows([card({ provider: 'openai', model_id: 'gpt-5.9-test', input: 10, output: 10, multipliers: { regional: 1.2 } })]);
    const usage = { model: 'gpt-5.9-test', prompt_tokens: 1_000_000, prompt_includes_cache: true, timestamp: '2026-09-15T00:00:00Z' };
    near(costs.rateUsage(usage).cost, 10, 'not served regionally: no uplift');
    registerEuServedModel('gpt-5.9-test');
    const eu = costs.rateUsage(usage);
    // an id the OpenAI catalogue does not know counts as new, so the uplift applies
    near(eu.multiplier.regional, 1.2, 'the catalogue factor replaces the built-in 1.1');
    near(eu.cost, 12);
});

// ─── evidence & fallbacks ────────────────────────────────────────────────────

test('an unknown model is labelled unknown with its source, and is not rated at the dearest model of all', () => {
    // Nothing to borrow from in this stub (no family, no provider): no invented number.
    // The estimate paths are in modelCosts.unknown.test.js.
    const r = costs.rateUsage({ model: 'totally-new-model', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    assert.strictEqual(r.cost_basis, 'unknown');
    assert.strictEqual(r.source, 'none');
    assert.ok(r.notes.includes('unknown_model'));
    assert.ok(r.cost < 15 + 120, 'never the pre-existing global upper bound');
    near(r.cost, 0, 'flagged and rated at 0 until priced');
});

test('a garbled price (NaN, negative) is never turned into a NaN or negative cost', async () => {
    overrides.value = { 'broken-model': { input: NaN, output: 1 }, 'negative-model': { input: -5, output: 1 } };
    await costs.refreshCustomOverrides();
    for (const m of ['broken-model', 'negative-model']) {
        const r = costs.rateUsage({ model: m, prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
        assert.ok(Number.isFinite(r.cost) && r.cost >= 0, `${m}: ${r.cost}`);
        assert.strictEqual(r.cost_basis, 'unknown');
        assert.ok(r.notes.includes('invalid_rates_ignored'));
    }
});

test('the result carries the rates used and splits input from output', () => {
    catalog.setRows([card({})]);
    const r = costs.rateUsage({ model: 'claude-cat-1', prompt_tokens: 2_000_000, completion_tokens: 1_000_000, cached_tokens: 1_000_000, prompt_includes_cache: false });
    near(r.input_cost, 2 * 5 + 1 * 0.5);
    near(r.output_cost, 25);
    near(r.cost, r.input_cost + r.output_cost);
    assert.deepStrictEqual(
        [r.price_input, r.price_output, r.price_cache_read],
        [5, 25, 0.5],
    );
    assert.strictEqual(r.provider, 'claude');
    assert.strictEqual(r.at.length, 24);
});

test('a bad timestamp or negative/NaN token counts cannot produce a negative or NaN cost', () => {
    catalog.setRows([card({})]);
    const r = costs.rateUsage({ model: 'claude-cat-1', timestamp: 'garbage', prompt_tokens: -5, completion_tokens: NaN, cached_tokens: 'x' });
    assert.strictEqual(r.cost, 0);
    assert.ok(Number.isFinite(Date.parse(r.at)));
});

// ─── the number-only API keeps its numbers ───────────────────────────────────

test('computeCost / computeCostSplit / getModelCost keep their old shape and numbers', () => {
    assert.deepStrictEqual(costs.getModelCost('gpt-4o'), PRICING['gpt-4o']);
    near(costs.computeCost('gpt-4o', 1_000_000, 1_000_000), 12.5);
    // Anthropic: prompt_tokens is the uncached remainder (legacy name rule, no flag passed)
    near(costs.computeCost('claude-sonnet-4-5', 2000, 500, 30000, 0, '5m'), (2000 / 1e6) * 3 + (30000 / 1e6) * 0.3 + (500 / 1e6) * 15);
    const split = costs.computeCostSplit('gpt-4o', 1_000_000, 1_000_000);
    near(split.input_cost, 2.5);
    near(split.output_cost, 10);
    near(costs.computeCost('gpt-4o', 1_000_000, 1_000_000), split.input_cost + split.output_cost);
});

test('computeCost takes the call timestamp and facts as a 7th argument; getModelCost as a 2nd', () => {
    catalog.setRows([
        card({ provider: 'openai', model_id: 'gpt-4o', input: 2, output: 8, valid_from: iso(NOW - 60 * DAY) }),
        card({ provider: 'openai', model_id: 'gpt-4o', input: 4, output: 16, valid_from: iso(NOW + 30 * DAY) }),
    ]);
    near(costs.computeCost('gpt-4o', 1_000_000, 0, 0, 0, null, { timestamp: iso(NOW) }), 2);
    near(costs.computeCost('gpt-4o', 1_000_000, 0, 0, 0, null, { timestamp: iso(NOW + 31 * DAY) }), 4);
    assert.deepStrictEqual(costs.getModelCost('gpt-4o', { at: NOW }), { input: 2, output: 8, cacheRead: 0.5 });
    assert.deepStrictEqual(costs.getModelCost('gpt-4o', { at: NOW + 31 * DAY }), { input: 4, output: 16, cacheRead: 0.5 });
    assert.deepStrictEqual(costs.getModelCost('gpt-4o'), { input: 2, output: 8, cacheRead: 0.5 }, 'default is now');
});

test('inferProviderType reads the adapter family from the id and the served-model registries', () => {
    assert.strictEqual(costs.inferProviderType('claude-opus-5'), 'claude');
    assert.strictEqual(costs.inferProviderType('gemini-3-pro'), 'google');
    assert.strictEqual(costs.inferProviderType('gpt-5.1'), 'openai');
    assert.strictEqual(costs.inferProviderType('o4-mini'), 'openai');
    assert.strictEqual(costs.inferProviderType('mistral-large-latest'), 'mistral');
    assert.strictEqual(costs.inferProviderType('qwen3.6-35b-a3b'), null);
    registerScalewayModel('qwen3.6-35b-a3b');
    assert.strictEqual(costs.inferProviderType('qwen3.6-35b-a3b'), 'scaleway');
});
