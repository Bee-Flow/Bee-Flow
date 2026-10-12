/**
 * DB-free tests — a model no price source knows is ESTIMATED, flagged and counted;
 * it is never rated at the dearest model of all.
 *
 * Real: modelCosts, the in-memory catalogue index, the estimate and the registry.
 * Stubbed: the config store and the community pricing data (a small deterministic
 * list, with one poisoned entry at $3,200 / $9,710 per 1M like the real outlier).
 *
 * Proven: the unknown-model basis and the source of the estimate on the row; the
 * nearest family and the provider level; the sanity cap against a poisoned donor; the
 * catalogue as a donor source (time-correct) and an admin override as a donor; the
 * registry entry per unknown call; Azure (a mapped deployment is priced as its model,
 * an unmapped one is flagged, not billed at a guessed rate); and a self-hosted model,
 * which never reaches any of it.
 *
 * Run: cd server && node --test core/llm/modelCosts.unknown.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const d = (id, vendor, input, output, over = {}) => ({ id, vendor, input, output, cacheRead: null, currency: 'USD', source: 'litellm', ...over });
const KNOWN = [
    d('gpt-5', 'openai', 1.25, 10, { cacheRead: 0.125 }),
    d('gpt-5-mini', 'openai', 0.25, 2),
    d('gpt-4.1', 'openai', 2, 8),
    d('gpt-4o', 'openai', 2.5, 10),
    d('o3', 'openai', 2, 8),
    d('o3-pro', 'openai', 20, 80),
    d('gpt-5.6-sol', 'openai', 5, 30),
    d('claude-sonnet-4-5', 'claude', 3, 15, { cacheRead: 0.3 }),
    d('claude-opus-4', 'claude', 15, 75),
    d('claude-opus-4-5', 'claude', 5, 25),
    d('claude-haiku-4-5', 'claude', 1, 5),
    d('claude-3-5-haiku', 'claude', 0.8, 4),
    d('claude-3-7-sonnet', 'claude', 3, 15),
    d('jais-30b-chat', null, 3200, 9710),                // the real-world outlier that set the old upper bound
    d('expensive-frontier-model', null, 15, 120),
    d('qwen3-235b', 'scaleway', 0.75, 2.25, { currency: 'EUR' }),
];
const PRICING = Object.fromEntries(KNOWN.map((k) => [k.id, { input: k.input, output: k.output, cacheRead: k.cacheRead || 0 }]));

const overrides = { value: null };
const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: async () => overrides.value,
        mutateConfig: async (_k, fn) => { overrides.value = fn(overrides.value); return overrides.value; },
        setConfig: () => { },
    },
    './pricingService': {
        getModelPricing: (name) => PRICING[name] || null,
        getModelPricingDetail: (name) => (PRICING[name] ? { ...PRICING[name], source: 'community', key: name, tiers: {}, longCtx: null } : null),
        getPricingByKey: () => null,
        initPricing: () => { },
        getAllModelPricing: () => PRICING,
        listKnownPricing: () => KNOWN,
    },
});

const catalog = require('../../stores/lib/priceCatalog');
const costs = require('./modelCosts');
const { setAzureDeployments, parseDeployments } = require('../providers/azureDeployments');
const { registerLocalModel, _resetLocalModelRegistry } = require('../providers/localModels');
const log = require('../../telemetry/log');

const warnings = [];
const realWarn = log.warn;
test.before(() => { log.warn = (...a) => { warnings.push(a.join(' ')); }; });
test.after(() => { log.warn = realWarn; restore(); });
test.beforeEach(async () => {
    catalog.clear();
    overrides.value = null;
    await costs.refreshCustomOverrides();
    setAzureDeployments([]);
    _resetLocalModelRegistry();
    costs.resetUnknownModels();
    warnings.length = 0;
});

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} — got ${a}, expected ${b}`);
const M = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_includes_cache: true };

test('same family: the nearest model is the rate, the row says unknown, why and from what', () => {
    const r = costs.rateUsage({ model: 'gpt-5.7-sol', ...M });
    assert.strictEqual(r.cost_basis, 'unknown');
    assert.strictEqual(r.source, 'estimate:family:gpt-5.6-sol');
    assert.ok(r.notes.includes('unknown_model') && r.notes.includes('estimate_family'));
    near(r.cost, 5 + 30);
    near(r.price_input, 5);
    near(r.price_output, 30);
    near(r.input_cost, 5);
    near(r.output_cost, 30);
    assert.strictEqual(r.currency, 'USD');
});

test('provider level: the upper quartile of the provider, never the dearest model of all', () => {
    const r = costs.rateUsage({ model: 'something-new-and-odd', provider_type: 'openai', ...M });
    assert.strictEqual(r.cost_basis, 'unknown');
    assert.strictEqual(r.source, 'estimate:provider:openai');
    assert.ok(r.notes.includes('estimate_provider'));
    assert.ok(r.cost > 0);
    // The old fallback rated every unknown model at the max of everything: 3200 in + 9710 out here.
    assert.ok(r.cost < 120, `${r.cost} is below even the dearest sane model`);
    assert.ok(r.price_input <= 20 && r.price_output <= 80, 'below the provider\'s own dearest (o3-pro 20/80)');
});

test('the provider comes from the id when no hint is given', () => {
    const r = costs.rateUsage({ model: 'claude-nova-1', ...M });
    assert.strictEqual(r.source, 'estimate:provider:claude');
    assert.ok(r.cost <= 15 + 75, 'never above Claude\'s own dearest model');
});

test('sanity cap: the poisoned $3,200/$9,710 entry is never a donor, and no estimate exceeds the cap', () => {
    const lookalike = costs.rateUsage({ model: 'jais-30b-chat-v2', ...M });
    assert.notStrictEqual(lookalike.source, 'estimate:family:jais-30b-chat');
    assert.ok(lookalike.cost < 1000);
    // the poisoned model itself is KNOWN to the community data, so it is priced as listed (the import job's checks own that)
    assert.strictEqual(costs.rateUsage({ model: 'jais-30b-chat', ...M }).cost_basis, 'list');
    for (const m of ['x-new', 'gpt-9-new', 'claude-new-9', 'qwen4-new']) {
        const r = costs.rateUsage({ model: m, ...M });
        assert.ok(r.price_input <= 100 && r.price_output <= 400, `${m}: ${r.price_input}/${r.price_output}`);
    }
});

test('nothing to borrow from: rated at 0 and flagged, not invented', () => {
    const r = costs.rateUsage({ model: 'zzz-unheard-of', ...M });
    assert.strictEqual(r.cost_basis, 'unknown');
    assert.strictEqual(r.source, 'none');
    assert.ok(r.notes.includes('no_price_data'));
    assert.strictEqual(r.cost, 0);
    assert.strictEqual(costs.rateUsage({ ...M }).cost_basis, 'unknown', 'a call without a model name is flagged too');
});

test('a non-chat unknown model (embedding, speech) never gets a chat rate', () => {
    const r = costs.rateUsage({ model: 'text-embedding-9-large', provider_type: 'openai', ...M });
    assert.strictEqual(r.cost_basis, 'unknown');
    assert.strictEqual(r.source, 'none');
    assert.strictEqual(r.cost, 0);
});

test('the catalogue is a donor, with the card in force at the call\'s time', () => {
    const day = 86_400_000;
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const base = { provider: 'google', tier: 'standard', currency: 'USD', cache_read: null, source: 'gemini-pricing', catalog_version: 'v1', long_ctx_threshold: null, long_ctx_rates: null, multipliers: null, cache_write_5m: null, cache_write_1h: null, valid_to: null };
    catalog.setRows([
        { ...base, model_id: 'gemini-9-flash', input: 0.3, output: 2.5, valid_from: iso(now - 100 * day) },
        { ...base, model_id: 'gemini-9-flash', input: 0.6, output: 5, valid_from: iso(now + 30 * day) },
    ]);
    const today = costs.rateUsage({ model: 'gemini-9.1-flash', ...M, timestamp: iso(now) });
    assert.strictEqual(today.source, 'estimate:family:gemini-9-flash');
    near(today.price_input, 0.3);
    const later = costs.rateUsage({ model: 'gemini-9.1-flash', ...M, timestamp: iso(now + 40 * day) });
    near(later.price_input, 0.6, 'a later call borrows the later card');
});

test('an admin override is a donor for its own family', async () => {
    overrides.value = { 'acme-large-1': { input: 4, output: 12 } };
    await costs.refreshCustomOverrides();
    const r = costs.rateUsage({ model: 'acme-large-2', ...M });
    assert.strictEqual(r.source, 'estimate:family:acme-large-1');
    near(r.cost, 16);
    // changing the override invalidates the memoised estimate
    await costs.setModelCost('acme-large-1', 8, 24);
    near(costs.rateUsage({ model: 'acme-large-2', ...M }).cost, 32);
});

test('each unknown call is counted in the registry, with the estimate it was rated at', () => {
    costs.rateUsage({ model: 'gpt-5.7-sol', ...M });
    costs.rateUsage({ model: 'gpt-5.7-sol', ...M });
    costs.rateUsage({ model: 'gpt-4.1', ...M });   // known: not recorded
    const seen = costs.listUnknownModels();
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].model, 'gpt-5.7-sol');
    assert.strictEqual(seen[0].provider, 'openai');
    assert.strictEqual(seen[0].calls, 2);
    assert.strictEqual(seen[0].estimate.source, 'estimate:family:gpt-5.6-sol');
    assert.strictEqual(warnings.length, 1, 'rate limited: two calls, one warning');
});

test('the estimate stays flat for a service tier (no invented tier multiplier) and keeps the unknown basis', () => {
    const r = costs.rateUsage({ model: 'gpt-5.7-sol', service_tier: 'batch', ...M });
    assert.strictEqual(r.cost_basis, 'unknown');
    near(r.cost, 35);
});

test('the estimate result is stable across calls (memoised) and does not depend on token counts', () => {
    const a = costs.rateUsage({ model: 'gpt-5.7-sol', prompt_tokens: 1000, completion_tokens: 10, prompt_includes_cache: true });
    const b = costs.rateUsage({ model: 'gpt-5.7-sol', prompt_tokens: 5_000_000, completion_tokens: 10, prompt_includes_cache: true });
    assert.strictEqual(a.source, b.source);
    near(a.price_input, b.price_input);
});

// ─── Azure ───────────────────────────────────────────────────────────────────

test('azure: a mapped deployment is priced as the model behind it, and is not unknown', () => {
    setAzureDeployments(parseDeployments('prod-chat=gpt-4o'));
    const r = costs.rateUsage({ model: 'prod-chat', provider_type: 'azure', ...M });
    assert.notStrictEqual(r.cost_basis, 'unknown');
    near(r.cost, 2.5 + 10);
    assert.deepStrictEqual(costs.listUnknownModels(), []);
});

test('azure: a deployment mapped to a model nothing prices is unknown under the REAL model id', () => {
    setAzureDeployments(parseDeployments('prod-chat=gpt-5.7-sol'));
    const r = costs.rateUsage({ model: 'prod-chat', provider_type: 'azure', ...M });
    assert.strictEqual(r.cost_basis, 'unknown');
    assert.strictEqual(r.source, 'estimate:family:gpt-5.6-sol');
    const [seen] = costs.listUnknownModels();
    assert.strictEqual(seen.model, 'gpt-5.7-sol');
    assert.strictEqual(seen.deployment, 'prod-chat');
    assert.strictEqual(seen.reason, 'unknown_model');
});

test('azure: an unmapped deployment is flagged as such, rated at a quartile estimate at most, never the old max', () => {
    const r = costs.rateUsage({ model: 'prod-chat', provider_type: 'azure', ...M });
    assert.strictEqual(r.cost_basis, 'unknown');
    assert.ok(r.notes.includes('unmapped_azure_deployment'));
    assert.ok(r.cost < 120, `${r.cost}`);
    const [seen] = costs.listUnknownModels();
    assert.strictEqual(seen.reason, 'unmapped_deployment');
    assert.strictEqual(seen.provider, 'azure');
    assert.strictEqual(seen.model, 'prod-chat');
    assert.match(warnings[0], /Azure deployment "prod-chat" is not mapped/);
});

test('azure: resolveBilledModel maps for Azure (or no provider) and leaves another provider\'s id alone', () => {
    setAzureDeployments(parseDeployments('prod-chat=gpt-4o'));
    assert.strictEqual(costs.resolveBilledModel('prod-chat', 'azure'), 'gpt-4o');
    assert.strictEqual(costs.resolveBilledModel('prod-chat'), 'gpt-4o');
    assert.strictEqual(costs.resolveBilledModel('prod-chat', 'openai'), 'prod-chat');
    assert.strictEqual(costs.resolveBilledModel('gpt-4.1', 'azure'), 'gpt-4.1');
    assert.strictEqual(costs.resolveBilledModel(undefined, 'azure'), undefined);
});

// ─── local ───────────────────────────────────────────────────────────────────

test('a self-hosted model stays at zero and never touches the estimate or the registry', () => {
    // names that WOULD match a family/provider estimate if they were not local
    for (const m of ['gpt-5.7-sol', 'claude-nova-1', 'unheard-of-9b']) registerLocalModel(m);
    for (const m of ['gpt-5.7-sol', 'claude-nova-1', 'unheard-of-9b']) {
        const r = costs.rateUsage({ model: m, provider_type: 'openai', ...M });
        assert.strictEqual(r.cost_basis, 'local', m);
        assert.strictEqual(r.cost, 0, m);
        assert.strictEqual(r.source, 'local', m);
    }
    assert.deepStrictEqual(costs.listUnknownModels(), []);
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(costs.computeCost('gpt-5.7-sol', 1_000_000, 1_000_000), 0);
});

test('computeCost and computeCostSplit use the estimate too, and agree', () => {
    const total = costs.computeCost('gpt-5.7-sol', 1_000_000, 1_000_000);
    const split = costs.computeCostSplit('gpt-5.7-sol', 1_000_000, 1_000_000);
    near(total, 35);
    near(split.input_cost + split.output_cost, total);
});
