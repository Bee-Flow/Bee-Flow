/**
 * usageStore.logUsage — time-correct rating and the evidence stored on the row,
 * against a REAL Postgres (@electric-sql/pglite behind db.js's pool,
 * testUtils/pglitePool.js). The store, the catalogue store, modelCosts and the
 * currency helper are the real ones; only the config store (FX rates), the
 * community pricing data (no network) and the PAYG drain worker (no Stripe) are
 * replaced.
 *
 * Proven:
 *   - the schema: an install whose ai_usage_log still has REAL cost columns is
 *     migrated to DOUBLE PRECISION without changing a stored value, the new
 *     evidence columns appear, the migration is idempotent, and a table above the
 *     size guard is left alone until it is forced (runbook);
 *   - KEY time-correctness: a catalogue card with a future valid_from does not
 *     touch calls logged before it, a call logged at an earlier timestamp is rated
 *     with the card of THAT time, a later price change never re-prices an old row,
 *     and a timestamp in the future is clamped to now;
 *   - every row carries the rates, source, catalogue version, cost basis,
 *     native currency, the FX rate applied, the tier and the usage facts;
 *   - currency: a EUR price on a EUR plan is not converted; USD on a EUR plan is
 *     converted once; EUR on a USD ledger is
 *     converted with the inverse rate; and the strict FX failure for a metered
 *     plan still refuses to log, while a fixed plan falls back to 1.0;
 *   - PAYG: billed_cost keeps full precision and equals the micro-units queued
 *     for Stripe (the float4 column used to disagree above a few euro).
 *
 * Run: cd server && node --test stores/usageStore.rating.pg.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');
const { usePglitePool } = require('../testUtils/pglitePool');

// ── test doubles ────────────────────────────────────────────────────────────

const PRICING = {
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
    'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
};
const fx = { rates: { EUR: '0.8' }, failFor: new Set(), lookups: [] };

const restoreStubs = installResolveStub({
    '../../stores/configStore': {
        getConfig: async (key) => {
            if (typeof key === 'string' && key.startsWith('currency_fx_usd_')) {
                const code = key.slice('currency_fx_usd_'.length).toUpperCase();
                fx.lookups.push(code);
                if (fx.failFor.has(code)) throw new Error('config store down');
                return fx.rates[code] ?? null;
            }
            return null; // no admin cost overrides
        },
        mutateConfig: async () => ({}),
        setConfig: async () => { },
    },
    './pricingService': {
        getModelPricing: (name) => PRICING[name] || null,
        getPricingByKey: () => null,
        initPricing: () => { },
        getAllModelPricing: () => PRICING,
        listKnownPricing: () => [
            { id: 'claude-sonnet-4-5', vendor: 'claude', input: 3, output: 15, cacheRead: 0.3, currency: 'USD', source: 'litellm' },
            { id: 'gpt-4o', vendor: 'openai', input: 2.5, output: 10, cacheRead: 1.25, currency: 'USD', source: 'litellm' },
        ],
    },
});

// The drain worker would talk to Stripe; the outbox row is what is asserted.
const drainPath = require.resolve('../workers/paygDrain');
require.cache[drainPath] = { id: drainPath, filename: drainPath, loaded: true, exports: { drainOne: async () => { } }, children: [], paths: [] };

const { pg, close } = usePglitePool();
const usageStore = require('./usageStore');
const catalogStore = require('./modelPriceCatalogStore');
const currency = require('../core/text/currency');
const { registerScalewayModel, _resetScalewayModelRegistry } = require('../core/providers/scalewayModels');
const { registerLocalModel, _resetLocalModelRegistry } = require('../core/providers/localModels');
const { setAzureDeployments, parseDeployments } = require('../core/providers/azureDeployments');
const { resetUnknownModels, listUnknownModels } = require('../core/llm/unknownModelRegistry');

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} — got ${a}, expected ${b}`);

const OLD_TABLE = `
    CREATE TABLE ai_usage_log (
        id SERIAL PRIMARY KEY, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_id TEXT, agent_id TEXT, agent_name TEXT,
        agent_type TEXT DEFAULT 'chat', model TEXT, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0, cache_ttl TEXT, stop_reason TEXT, parent_call_id TEXT, swarm_run_id TEXT,
        tool_name TEXT, source TEXT DEFAULT 'unknown', duration_ms INTEGER DEFAULT 0, organization_id TEXT,
        estimated_cost REAL DEFAULT 0, conversation_id TEXT, billed_cost REAL
    )`;

before(async () => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    // An install from before this change: REAL cost columns and one legacy row.
    await pg.exec(OLD_TABLE);
    await pg.query(`INSERT INTO ai_usage_log (model, prompt_tokens, estimated_cost, billed_cost, source) VALUES ('legacy-model', 10, 0.1, 0.12, 'legacy')`);
    await pg.exec(`
        CREATE TABLE subscription_plans (id TEXT PRIMARY KEY, billing_model TEXT, markup_percent NUMERIC, stripe_meter_event_name TEXT, currency TEXT);
        CREATE TABLE organization_subscriptions (organization_id TEXT PRIMARY KEY, stripe_customer_id TEXT, status TEXT, plan_id TEXT);
        CREATE TABLE consumer_subscriptions (user_id TEXT PRIMARY KEY, stripe_customer_id TEXT, status TEXT, plan_id TEXT);
    `);
    await usageStore.initDB();
    await catalogStore.initDB();
});

after(async () => {
    restoreStubs();
    delete process.env.DEPLOYMENT_MODE;
    await close();
});

beforeEach(() => {
    fx.rates = { EUR: '0.8' };
    fx.failFor.clear();
    fx.lookups.length = 0;
    currency.invalidateFxCache();
    usageStore.invalidatePaygCache();
    _resetScalewayModelRegistry();
    _resetLocalModelRegistry();
    setAzureDeployments([]);
    resetUnknownModels();
    process.env.DEPLOYMENT_MODE = 'self-hosted';
});

// A self-hosted install has no plan currency: every org's ledger is USD. (A call with
// neither an org nor a user falls back to the plan default, EUR.)
const lastRow = async (where = '', params = []) =>
    (await pg.query(`SELECT * FROM ai_usage_log ${where} ORDER BY id DESC LIMIT 1`, params)).rows[0];

function card(over = {}) {
    return {
        provider: 'claude', model_id: 'claude-rated-1', tier: 'standard', currency: 'USD',
        input: 5, output: 25, cache_read: 0.5, source: 'anthropic-pricing', catalog_version: 'v-old',
        valid_from: iso(NOW - 60 * DAY),
        ...over,
    };
}

// ── schema ──────────────────────────────────────────────────────────────────

test('an install with REAL cost columns is widened without changing a stored value', async () => {
    const { rows: cols } = await pg.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ai_usage_log'`);
    const type = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    assert.strictEqual(type.estimated_cost, 'double precision');
    assert.strictEqual(type.billed_cost, 'double precision');
    for (const c of ['price_input', 'price_output', 'price_cache_read', 'price_cache_write', 'price_source', 'catalog_version',
        'cost_basis', 'price_currency', 'currency', 'fx_rate', 'service_tier', 'usage_raw']) {
        assert.ok(type[c], `column ${c}`);
    }
    assert.strictEqual(type.usage_raw, 'jsonb');
    const legacy = (await pg.query(`SELECT estimated_cost::text AS e, billed_cost::text AS b FROM ai_usage_log WHERE source = 'legacy'`)).rows[0];
    assert.strictEqual(legacy.e, '0.1', 'float4 0.1 became 0.1, not 0.10000000149011612');
    assert.strictEqual(legacy.b, '0.12');
});

test('the migration is idempotent', async () => {
    assert.deepStrictEqual(await usageStore.widenCostColumns(), { widened: false, reason: 'already_wide' });
    await usageStore.initDB();
});

test('a table above the size guard keeps REAL until the runbook forces it', async () => {
    await pg.exec('ALTER TABLE ai_usage_log ALTER COLUMN billed_cost TYPE REAL');
    const typeOf = async () => (await pg.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'ai_usage_log' AND column_name = 'billed_cost'`)).rows[0].data_type;
    assert.strictEqual(await typeOf(), 'real');
    assert.deepStrictEqual(await usageStore.widenCostColumns({ maxRows: 0 }), { widened: false, reason: 'table_too_large' });
    assert.strictEqual(await typeOf(), 'real', 'boot leaves a big table alone');
    assert.deepStrictEqual(await usageStore.widenCostColumns({ force: true }), { widened: true });
    assert.strictEqual(await typeOf(), 'double precision');
});

// ── time-correctness ────────────────────────────────────────────────────────

test('KEY: a catalogue card with a future valid_from does not affect calls logged before it; old rows are never re-priced', async () => {
    const stepUp = NOW + 30 * DAY;
    await catalogStore.addPrice(card({ input: 5, output: 25, catalog_version: 'v-old', valid_from: iso(NOW - 60 * DAY) }));
    await catalogStore.addPrice(card({ input: 10, output: 50, catalog_version: 'v-future', valid_from: iso(stepUp) }));
    const usage = { model: 'claude-rated-1', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_includes_cache: false, source: 'time-test', organization_id: 'org-selfhost' };

    await usageStore.logUsage({ ...usage, timestamp: iso(NOW - 20 * DAY) });
    const lastMonth = await lastRow(`WHERE source = 'time-test'`);
    await usageStore.logUsage({ ...usage });
    const today = await lastRow(`WHERE source = 'time-test'`);

    near(lastMonth.estimated_cost, 30, 'last month paid the card of last month');
    near(today.estimated_cost, 30, 'today pays the card in force today: the step-up is still in the future');
    assert.strictEqual(lastMonth.catalog_version, 'v-old');
    assert.strictEqual(today.catalog_version, 'v-old');
    assert.strictEqual(today.price_source, 'anthropic-pricing');

    // A timestamp in the future is clamped to now: it cannot reach the future card early.
    await usageStore.logUsage({ ...usage, timestamp: iso(stepUp + DAY) });
    const clamped = await lastRow(`WHERE source = 'time-test'`);
    assert.strictEqual(clamped.catalog_version, 'v-old');
    near(clamped.estimated_cost, 30);

    // The importer now detects a price change effective yesterday: new calls pay it, stored rows do not move.
    const snapshot = (await pg.query(`SELECT id, estimated_cost, price_input, catalog_version FROM ai_usage_log WHERE source = 'time-test' ORDER BY id`)).rows;
    await catalogStore.addPrice(card({ input: 8, output: 40, catalog_version: 'v-yesterday', valid_from: iso(NOW - DAY) }));
    await usageStore.logUsage({ ...usage });
    const afterChange = await lastRow(`WHERE source = 'time-test'`);
    near(afterChange.estimated_cost, 48, 'a call after the change pays the new card');
    assert.strictEqual(afterChange.catalog_version, 'v-yesterday');
    await usageStore.logUsage({ ...usage, timestamp: iso(NOW - 20 * DAY) });
    const backdated = await lastRow(`WHERE source = 'time-test'`);
    near(backdated.estimated_cost, 30, 'a late-arriving log line for last month still gets last month\'s price');

    const again = (await pg.query(`SELECT id, estimated_cost, price_input, catalog_version FROM ai_usage_log WHERE id = ANY($1::int[]) ORDER BY id`, [snapshot.map((r) => r.id)])).rows;
    assert.deepStrictEqual(again, snapshot, 'no stored row was touched by a later catalogue change');
});

// ── evidence ────────────────────────────────────────────────────────────────

test('a row stores the rates it was priced with and the usage facts', async () => {
    await catalogStore.addPrice(card({ model_id: 'claude-evidence-1', cache_write_5m: 6.25, cache_write_1h: 10, multipliers: { batch: 0.5, geo: { us: 1.1 } }, catalog_version: 'v-ev' }));
    await usageStore.logUsage({
        model: 'claude-evidence-1', source: 'evidence', organization_id: 'org-selfhost',
        prompt_tokens: 1000, completion_tokens: 2000, cached_tokens: 3000, prompt_includes_cache: false,
        cache_creation_tokens: 4000, cache_creation_5m_tokens: 1000, cache_creation_1h_tokens: 3000, cache_ttl: '1h',
        service_tier: 'batch', inference_geo: 'us',
        tool_use: { web_search_requests: 2 }, modality: { prompt: { text: 1000 } },
    });
    const row = await lastRow(`WHERE source = 'evidence'`);
    // 0.5 (batch) x 1.1 (us) on every category
    const mult = 0.5 * 1.1;
    near(row.price_input, 5 * mult);
    near(row.price_output, 25 * mult);
    near(row.price_cache_read, 0.5 * mult);
    near(row.price_cache_write, ((1000 * 6.25) + (3000 * 10)) / 4000 * mult, 'token-weighted write rate of the mixed write');
    assert.strictEqual(typeof row.price_input, 'number', 'doubles arrive as numbers, not strings');
    near(row.estimated_cost, ((1000 * 5 + 3000 * 0.5 + 1000 * 6.25 + 3000 * 10 + 2000 * 25) / 1e6) * mult);
    assert.strictEqual(row.price_source, 'anthropic-pricing');
    assert.strictEqual(row.catalog_version, 'v-ev');
    assert.strictEqual(row.cost_basis, 'exact');
    assert.strictEqual(row.price_currency, 'USD');
    assert.strictEqual(row.currency, 'USD');
    assert.strictEqual(row.fx_rate, 1);
    assert.strictEqual(row.service_tier, 'batch');
    assert.strictEqual(row.usage_raw.v, 1);
    assert.strictEqual(row.usage_raw.usage.cache_creation_5m_tokens, 1000);
    assert.strictEqual(row.usage_raw.usage.cache_creation_1h_tokens, 3000);
    assert.strictEqual(row.usage_raw.usage.inference_geo, 'us');
    assert.deepStrictEqual(row.usage_raw.usage.tool_use, { web_search_requests: 2 });
    assert.strictEqual(row.usage_raw.pricing.tier, 'batch');
    assert.strictEqual(row.usage_raw.pricing.multiplier.geo, 1.1);
});

test('a call without a reported tier stores no tier; the community price is a list price', async () => {
    await usageStore.logUsage({ model: 'gpt-4o', source: 'evidence-list', organization_id: 'org-selfhost', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    const row = await lastRow(`WHERE source = 'evidence-list'`);
    near(row.estimated_cost, 12.5);
    assert.strictEqual(row.service_tier, null);
    assert.strictEqual(row.cost_basis, 'list');
    assert.strictEqual(row.price_source, 'litellm');
    assert.strictEqual(row.catalog_version, null);
});

test('an unknown model is stored as such: flagged, and never rated at the old upper bound', async () => {
    // No family and no provider to borrow from: no invented number, the row says so.
    await usageStore.logUsage({ model: 'brand-new-model', source: 'evidence-unknown', prompt_tokens: 1000, completion_tokens: 1000 });
    const unknown = await lastRow(`WHERE source = 'evidence-unknown'`);
    assert.strictEqual(unknown.cost_basis, 'unknown');
    assert.strictEqual(unknown.price_source, 'none');
    assert.strictEqual(unknown.estimated_cost, 0);
    assert.ok(unknown.usage_raw.pricing.notes.includes('unknown_model'));
    assert.strictEqual(listUnknownModels()[0].model, 'brand-new-model');

    registerLocalModel('my-local-model');
    await usageStore.logUsage({ model: 'my-local-model', source: 'evidence-local', prompt_tokens: 1000, completion_tokens: 1000 });
    const local = await lastRow(`WHERE source = 'evidence-local'`);
    assert.strictEqual(local.cost_basis, 'local');
    assert.strictEqual(local.estimated_cost, 0);
    assert.strictEqual(local.price_input, 0);
    assert.strictEqual(local.price_source, 'local');
});

test('usage_raw is built from a whitelist and capped: a huge provider object cannot bloat the row', async () => {
    const huge = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, 'x'.repeat(50)]));
    await usageStore.logUsage({
        model: 'gpt-4o', source: 'evidence-huge', prompt_tokens: 10, completion_tokens: 10,
        tool_use: huge, modality: huge, evil_field: { __proto__: { polluted: 1 }, secret: 'do-not-store' }, raw: { token: 'sk-secret' },
    });
    const row = await lastRow(`WHERE source = 'evidence-huge'`);
    const json = JSON.stringify(row.usage_raw);
    assert.ok(json.length <= 8 * 1024, `usage_raw ${json.length} bytes`);
    assert.ok(!json.includes('do-not-store') && !json.includes('sk-secret'), 'only whitelisted fields are stored');
    assert.strictEqual(row.usage_raw.usage.tool_use, null);
});

// ── currency ────────────────────────────────────────────────────────────────

test('self-hosted (USD ledger): a Scaleway EUR price is converted with the inverse of USD->EUR', async () => {
    await catalogStore.addPrice({
        provider: 'scaleway', model_id: 'qwen-fx-1', currency: 'EUR', input: 1, output: 1,
        source: 'scaleway-product-catalog', catalog_version: 'sw1', valid_from: iso(NOW - DAY),
    });
    registerScalewayModel('qwen-fx-1');
    await usageStore.logUsage({ model: 'qwen-fx-1', source: 'fx-selfhost', organization_id: 'org-selfhost', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    const row = await lastRow(`WHERE source = 'fx-selfhost'`);
    assert.strictEqual(row.price_currency, 'EUR');
    assert.strictEqual(row.currency, 'USD');
    near(row.fx_rate, 1 / 0.8);
    near(row.estimated_cost, 2 / 0.8, 'EUR 2.00 -> USD 2.50');
    assert.strictEqual(row.price_source, 'scaleway-product-catalog');
});

test('cloud EUR plan: a EUR price is not converted (no USD round trip); a USD price is converted once', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    await pg.query(`INSERT INTO subscription_plans VALUES ('eur-fixed', 'fixed', 0, NULL, 'EUR') ON CONFLICT DO NOTHING`);
    await pg.query(`INSERT INTO organization_subscriptions VALUES ('org-eur', NULL, 'active', 'eur-fixed') ON CONFLICT DO NOTHING`);
    await catalogStore.addPrice({
        provider: 'scaleway', model_id: 'qwen-eur-1', currency: 'EUR', input: 1, output: 1,
        source: 'scaleway-product-catalog', catalog_version: 'sw1', valid_from: iso(NOW - DAY),
    });
    registerScalewayModel('qwen-eur-1');

    await usageStore.logUsage({ model: 'qwen-eur-1', organization_id: 'org-eur', source: 'fx-eur-native', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    const native = await lastRow(`WHERE source = 'fx-eur-native'`);
    assert.strictEqual(native.fx_rate, 1);
    assert.strictEqual(native.estimated_cost, 2, 'no USD round trip: exactly the EUR figure');
    assert.strictEqual(native.currency, 'EUR');

    await usageStore.logUsage({ model: 'gpt-4o', organization_id: 'org-eur', source: 'fx-usd-native', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    const converted = await lastRow(`WHERE source = 'fx-usd-native'`);
    assert.strictEqual(converted.price_currency, 'USD');
    assert.strictEqual(converted.currency, 'EUR');
    near(converted.fx_rate, 0.8);
    near(converted.estimated_cost, 12.5 * 0.8);
});

test('a fixed plan whose FX lookup fails still logs, at 1.0, and says so', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    await pg.query(`INSERT INTO subscription_plans VALUES ('gbp-fixed', 'fixed', 0, NULL, 'GBP') ON CONFLICT DO NOTHING`);
    await pg.query(`INSERT INTO organization_subscriptions VALUES ('org-gbp-fixed', NULL, 'active', 'gbp-fixed') ON CONFLICT DO NOTHING`);
    fx.failFor.add('GBP');
    await usageStore.logUsage({ model: 'gpt-4o', organization_id: 'org-gbp-fixed', source: 'fx-fixed-fail', prompt_tokens: 1_000_000, completion_tokens: 0 });
    const row = await lastRow(`WHERE source = 'fx-fixed-fail'`);
    assert.strictEqual(row.fx_rate, 1);
    assert.strictEqual(row.currency, 'GBP');
    near(row.estimated_cost, 2.5);
});

test('STRICT: a metered plan whose FX lookup fails refuses to log (no wrong number is written)', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    await pg.query(`INSERT INTO subscription_plans VALUES ('gbp-payg', 'metered', 20, 'beeflow_payg', 'GBP') ON CONFLICT DO NOTHING`);
    await pg.query(`INSERT INTO organization_subscriptions VALUES ('org-gbp-payg', 'cus_gbp', 'active', 'gbp-payg') ON CONFLICT DO NOTHING`);
    fx.failFor.add('GBP');
    const before = (await pg.query(`SELECT COUNT(*)::int AS n FROM ai_usage_log`)).rows[0].n;
    await assert.rejects(
        usageStore.logUsage({ model: 'gpt-4o', organization_id: 'org-gbp-payg', source: 'fx-strict', prompt_tokens: 1_000_000, completion_tokens: 0 }),
        /^Error: fx_rate_unavailable: USD→GBP/);
    assert.strictEqual((await pg.query(`SELECT COUNT(*)::int AS n FROM ai_usage_log`)).rows[0].n, before, 'nothing was logged');
    assert.strictEqual((await pg.query(`SELECT COUNT(*)::int AS n FROM payg_meter_outbox WHERE usage_log_id IS NOT NULL AND identifier LIKE 'usage_%' AND stripe_customer_id = 'cus_gbp'`)).rows[0].n, 0);
});

test('PAYG: billed_cost keeps full precision and matches the micro-units queued for Stripe', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    await pg.query(`INSERT INTO subscription_plans VALUES ('eur-payg', 'metered', 25, 'beeflow_payg', 'EUR') ON CONFLICT DO NOTHING`);
    await pg.query(`INSERT INTO organization_subscriptions VALUES ('org-eur-payg', 'cus_eur', 'active', 'eur-payg') ON CONFLICT DO NOTHING`);
    await catalogStore.addPrice(card({ model_id: 'claude-payg-1', input: 12.345678, output: 0, catalog_version: 'v-payg' }));

    // 9.87654 M input tokens at 12.345678 USD/M = 121.9323...; x0.8 EUR; x1.25 markup.
    await usageStore.logUsage({ model: 'claude-payg-1', organization_id: 'org-eur-payg', source: 'payg-precision', prompt_tokens: 9_876_540, prompt_includes_cache: false });
    const row = await lastRow(`WHERE source = 'payg-precision'`);
    const expectedCost = (9_876_540 / 1e6) * 12.345678 * 0.8;
    near(row.estimated_cost, expectedCost, 'estimated_cost is not float4-rounded');
    near(row.billed_cost, expectedCost * 1.25, 'billed_cost carries the markup at full precision');
    const outbox = (await pg.query(`SELECT amount_micro_units, event_name, stripe_customer_id FROM payg_meter_outbox WHERE usage_log_id = $1`, [row.id])).rows[0];
    assert.ok(outbox, 'an outbox row was queued');
    assert.strictEqual(String(outbox.amount_micro_units), String(Math.round(row.billed_cost * 1_000_000)),
        'the stored billed_cost and the Stripe amount agree to the micro-unit');
    assert.strictEqual(outbox.event_name, 'beeflow_payg');
    assert.strictEqual(outbox.stripe_customer_id, 'cus_eur');
    assert.strictEqual(row.currency, 'EUR');
});

test('a call below one micro-unit is logged but queues nothing for Stripe (unchanged behaviour)', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    await pg.query(`INSERT INTO subscription_plans VALUES ('eur-payg2', 'metered', 0, 'beeflow_payg', 'EUR') ON CONFLICT DO NOTHING`);
    await pg.query(`INSERT INTO organization_subscriptions VALUES ('org-eur-payg2', 'cus_eur2', 'active', 'eur-payg2') ON CONFLICT DO NOTHING`);
    await usageStore.logUsage({ model: 'gpt-4o', organization_id: 'org-eur-payg2', source: 'payg-tiny', prompt_tokens: 0, completion_tokens: 0 });
    const row = await lastRow(`WHERE source = 'payg-tiny'`);
    assert.strictEqual(row.estimated_cost, 0);
    assert.strictEqual((await pg.query(`SELECT COUNT(*)::int AS n FROM payg_meter_outbox WHERE usage_log_id = $1`, [row.id])).rows[0].n, 0);
});

test('an unknown model with a same-family neighbour is stored as an estimate from that neighbour', async () => {
    await usageStore.logUsage({ model: 'claude-sonnet-4-6', source: 'evidence-family', organization_id: 'org-selfhost', prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_includes_cache: false });
    const row = await lastRow(`WHERE source = 'evidence-family'`);
    assert.strictEqual(row.cost_basis, 'unknown', 'an estimate is still not a known price');
    assert.strictEqual(row.price_source, 'estimate:family:claude-sonnet-4-5');
    near(row.price_input, 3);
    near(row.price_output, 15);
    near(row.estimated_cost, 18);
    assert.ok(row.usage_raw.pricing.notes.includes('estimate_family'));
});

test('an Azure call is logged and priced as the model behind the deployment; the deployment stays in usage_raw', async () => {
    setAzureDeployments(parseDeployments('prod-chat=gpt-4o'));
    await usageStore.logUsage({ model: 'prod-chat', provider_type: 'azure', source: 'evidence-azure', organization_id: 'org-selfhost', prompt_tokens: 1_000_000, completion_tokens: 0 });
    const row = await lastRow(`WHERE source = 'evidence-azure'`);
    assert.strictEqual(row.model, 'gpt-4o');
    assert.strictEqual(row.usage_raw.pricing.deployment, 'prod-chat');
    near(row.estimated_cost, 2.5);
    assert.notStrictEqual(row.cost_basis, 'unknown');
    assert.deepStrictEqual(listUnknownModels(), []);

    // A later re-mapping of the deployment does not change what the stored row means.
    setAzureDeployments(parseDeployments('prod-chat=claude-sonnet-4-5'));
    assert.strictEqual((await lastRow(`WHERE source = 'evidence-azure'`)).model, 'gpt-4o');
});

test('an Azure deployment that is not mapped is flagged, not billed at a guessed rate', async () => {
    await usageStore.logUsage({ model: 'prod-chat', provider_type: 'azure', source: 'evidence-azure-unmapped', organization_id: 'org-selfhost', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    const row = await lastRow(`WHERE source = 'evidence-azure-unmapped'`);
    assert.strictEqual(row.model, 'prod-chat');
    assert.strictEqual(row.cost_basis, 'unknown');
    assert.ok(row.usage_raw.pricing.notes.includes('unmapped_azure_deployment'));
    assert.ok(row.estimated_cost < 15 + 120, 'not the global upper bound');
    const seen = listUnknownModels();
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].reason, 'unmapped_deployment');
    assert.strictEqual(seen[0].provider, 'azure');
});
