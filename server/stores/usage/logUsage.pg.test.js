// @typecheck
/**
 * logUsage (createLogUsage) with its four dependencies handed in: a fixed
 * rating, a fixed billed-model lookup, a currency helper whose USD rates the
 * test sets, and a drain worker that records what it was asked to drain. The
 * row write, the PAYG target and the plan currency are the real ones, on
 * PGlite. What is pinned: the row's defaults, which currency the ledger is in,
 * the FX decision for metered and fixed plans, the markup and the Stripe
 * outbox row, and which errors reach the caller.
 *
 * Run: cd server && node --test stores/usage/logUsage.pg.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { createLogUsage } = require('./logUsage');
const { initDB } = require('./schema');
const { invalidatePaygCache } = require('./payg');

/** @type {Record<string, unknown>} */
const RATED = {
    price_input: 1, price_output: 2, price_cache_read: 0.1, price_cache_write: 1.25, source: 'test-card',
    catalog_version: 'v1', cost_basis: 'list', at: 'now', tier: 'priority', inference_geo: null, long_context: false,
    valid_from: null, rates: {}, multiplier: 1, notes: [],
};
const state = {
    /** @type {{ cost: number, currency: string }} */
    rating: { cost: 2, currency: 'USD' },
    /** @type {Record<string, unknown>[]} */
    rateCalls: [],
    /** @type {Record<string, number | Error>} */
    usdRates: {},
    /** @type {string[]} */
    drained: [],
    /** @type {Record<string, string>} */
    billedModels: {},
};

const { logUsage } = createLogUsage({
    rateUsage: (/** @type {Record<string, unknown>} */ args) => { state.rateCalls.push(args); return { ...RATED, ...state.rating }; },
    resolveBilledModel: (/** @type {string} */ model) => state.billedModels[model] || null,
    loadCurrency: () => ({
        getUsdToCurrencyRate: async (/** @type {string} */ c) => {
            const r = state.usdRates[c];
            if (r instanceof Error) throw r;
            return r ?? (c === 'USD' ? 1 : NaN);
        },
    }),
    loadPaygDrain: () => ({ drainOne: async (/** @type {string} */ id) => { state.drained.push(id); } }),
});

const near = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-9, `got ${a}, expected ${b}`);
/** @param {string} source */
const rowOf = async (source) => /** @type {Record<string, any>} */ ((await pg.query('SELECT * FROM ai_usage_log WHERE source = $1 ORDER BY id DESC LIMIT 1', [source])).rows[0]);
/** @param {unknown} id */
const outboxOf = async (id) => /** @type {Record<string, any>[]} */ ((await pg.query('SELECT * FROM payg_meter_outbox WHERE usage_log_id = $1', [id])).rows);
const rowCount = async () => Number(/** @type {any} */ ((await pg.query('SELECT COUNT(*)::int AS n FROM ai_usage_log')).rows[0]).n);
const nextTick = () => new Promise((r) => setImmediate(r));

before(async () => {
    await pg.exec(`
        CREATE TABLE subscription_plans (id TEXT PRIMARY KEY, billing_model TEXT, markup_percent NUMERIC, stripe_meter_event_name TEXT, currency TEXT);
        CREATE TABLE organization_subscriptions (organization_id TEXT PRIMARY KEY, stripe_customer_id TEXT, status TEXT, plan_id TEXT);
        CREATE TABLE consumer_subscriptions (user_id TEXT PRIMARY KEY, stripe_customer_id TEXT, status TEXT, plan_id TEXT);
        INSERT INTO subscription_plans VALUES ('payg-gbp', 'metered', 20, 'beeflow_payg', 'GBP'), ('fixed-gbp', 'fixed', 0, NULL, 'GBP'), ('payg-usd', 'metered', 50, 'beeflow_payg', 'USD');
        INSERT INTO organization_subscriptions VALUES ('org-payg', 'cus_payg', 'active', 'payg-gbp'), ('org-fixed', NULL, 'active', 'fixed-gbp'), ('org-payg-usd', 'cus_usd', 'active', 'payg-usd');
        INSERT INTO consumer_subscriptions VALUES ('u-payg', 'cus_u', 'trialing', 'payg-gbp');
    `);
    await initDB();
});
after(async () => { delete process.env.DEPLOYMENT_MODE; await close(); });

beforeEach(async () => {
    await nextTick(); // drains the last test scheduled land before the reset
    process.env.DEPLOYMENT_MODE = 'cloud';
    invalidatePaygCache(null, null);
    Object.assign(state, { rating: { cost: 2, currency: 'USD' }, rateCalls: [], usdRates: { GBP: 0.5, EUR: 0.8 }, drained: [], billedModels: {} });
});

test('an entry with nothing in it is a row of defaults', async () => {
    state.rating = { cost: 0, currency: 'USD' };
    await logUsage({});
    const row = (await pg.query('SELECT * FROM ai_usage_log ORDER BY id DESC LIMIT 1')).rows[0];
    assert.deepEqual(
        [row.model, row.prompt_tokens, row.completion_tokens, row.total_tokens, row.agent_type, row.source, row.duration_ms, row.client, row.user_id, row.billed_cost, row.service_tier],
        ['unknown', 0, 0, 0, 'chat', 'unknown', 0, 'unknown', null, null, null]);
    assert.deepEqual([row.price_currency, row.currency, row.fx_rate], ['USD', 'USD', 1]);
});

test('token totals: the sum unless the caller gives one; the tier only when the provider reported one', async () => {
    await logUsage({ source: 'tot-sum', prompt_tokens: 3, completion_tokens: 4 });
    await logUsage({ source: 'tot-given', prompt_tokens: 3, completion_tokens: 4, total_tokens: 99, service_tier: 'priority' });
    await logUsage({ source: 'tot-traffic', traffic_type: 'ON_DEMAND' });
    assert.deepEqual([(await rowOf('tot-sum')).total_tokens, (await rowOf('tot-sum')).service_tier], [7, null]);
    assert.deepEqual([(await rowOf('tot-given')).total_tokens, (await rowOf('tot-given')).service_tier], [99, 'priority']);
    assert.equal((await rowOf('tot-traffic')).service_tier, 'priority');
});

test('a deployment name is billed as the model behind it, rated as azure, at a timestamp never in the future', async () => {
    state.billedModels = { 'prod-chat': 'gpt-4o' };
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await logUsage({ source: 'deploy', model: 'prod-chat', timestamp: future });
    await logUsage({ source: 'deploy-typed', model: 'prod-chat', provider_type: 'openai' });
    assert.equal((await rowOf('deploy')).model, 'gpt-4o');
    assert.equal((await rowOf('deploy')).usage_raw.pricing.deployment, 'prod-chat');
    assert.deepEqual(state.rateCalls.map((c) => [c.model, c.provider_type]), [['gpt-4o', 'azure'], ['gpt-4o', 'openai']]);
    assert.ok(/** @type {Date} */ (state.rateCalls[0].timestamp).getTime() <= Date.now(), 'clamped to now');
});

test('the ledger currency: free calls stay in the price currency; an org gets its plan currency; nobody gets EUR', async () => {
    state.rating = { cost: 0, currency: 'EUR' };
    await logUsage({ source: 'cur-free', organization_id: 'org-fixed' });
    assert.deepEqual([(await rowOf('cur-free')).currency, (await rowOf('cur-free')).fx_rate], ['EUR', 1]);

    state.rating = { cost: 2, currency: 'USD' };
    await logUsage({ source: 'cur-fixed', organization_id: 'org-fixed' });
    const fixed = await rowOf('cur-fixed');
    assert.deepEqual([fixed.price_currency, fixed.currency, fixed.fx_rate, fixed.billed_cost], ['USD', 'GBP', 0.5, null]);
    near(fixed.estimated_cost, 1);

    await logUsage({ source: 'cur-nobody' });
    const nobody = await rowOf('cur-nobody');
    assert.deepEqual([nobody.currency, nobody.fx_rate], ['EUR', 0.8]);

    await logUsage({ source: 'cur-unknown-org', organization_id: 'org-none' });
    assert.equal((await rowOf('cur-unknown-org')).currency, 'EUR');
});

test('a price already in the ledger currency is not converted', async () => {
    state.rating = { cost: 2, currency: 'GBP' };
    state.usdRates = {};
    await logUsage({ source: 'same-cur', organization_id: 'org-fixed' });
    assert.deepEqual([(await rowOf('same-cur')).fx_rate, (await rowOf('same-cur')).estimated_cost], [1, 2]);
});

test('a fixed plan logs at 1.0 when the rate lookup fails or gives no usable rate', async () => {
    state.usdRates = { GBP: new Error('rates down') };
    await logUsage({ source: 'fixed-throw', organization_id: 'org-fixed' });
    state.usdRates = { GBP: 0 };
    await logUsage({ source: 'fixed-zero', organization_id: 'org-fixed' });
    for (const s of ['fixed-throw', 'fixed-zero']) {
        const row = await rowOf(s);
        assert.deepEqual([row.currency, row.fx_rate, row.estimated_cost], ['GBP', 1, 2], s);
    }
});

test('a metered plan without a usable rate refuses to log and tells the caller; any other FX error is swallowed with no row', async () => {
    state.usdRates = { GBP: 0 };
    const before = await rowCount();
    await assert.rejects(logUsage({ source: 'payg-zero', organization_id: 'org-payg' }), /^Error: fx_rate_unavailable: USD→GBP$/);
    state.usdRates = { GBP: new Error('fx_rate_unavailable: USD→GBP') };
    await assert.rejects(logUsage({ source: 'payg-strict', organization_id: 'org-payg' }), /fx_rate_unavailable/);
    state.usdRates = { GBP: new Error('rates down') };
    await logUsage({ source: 'payg-other', organization_id: 'org-payg' });
    assert.equal(await rowCount(), before, 'no row for any of the three');
});

test('PAYG: the converted cost carries the markup, one outbox row in micro-units, one drain of it', async () => {
    await logUsage({ source: 'payg-ok', organization_id: 'org-payg', prompt_tokens: 10 });
    const row = await rowOf('payg-ok');
    near(row.estimated_cost, 1);
    near(row.billed_cost, 1.2);
    assert.equal(row.currency, 'GBP');
    const [outbox] = await outboxOf(row.id);
    assert.deepEqual([String(outbox.amount_micro_units), outbox.stripe_customer_id, outbox.event_name, outbox.identifier],
        ['1200000', 'cus_payg', 'beeflow_payg', `usage_${row.id}`]);
    await nextTick();
    assert.deepEqual(state.drained, [`usage_${row.id}`]);

    // A consumer on a PAYG plan the same way; a USD plan needs no conversion.
    await logUsage({ source: 'payg-user', user_id: 'u-payg' });
    near((await rowOf('payg-user')).billed_cost, 1.2);
    await logUsage({ source: 'payg-usd', organization_id: 'org-payg-usd' });
    const usd = await rowOf('payg-usd');
    assert.deepEqual([usd.currency, usd.fx_rate], ['USD', 1]);
    near(usd.billed_cost, 3);
});

test('PAYG: a call below one micro-unit, or a self-hosted install, queues nothing', async () => {
    state.rating = { cost: 1e-7, currency: 'USD' };
    await logUsage({ source: 'payg-tiny', organization_id: 'org-payg' });
    const tiny = await rowOf('payg-tiny');
    assert.ok(tiny.billed_cost > 0);
    assert.deepEqual(await outboxOf(tiny.id), []);

    state.rating = { cost: 2, currency: 'USD' };
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    await logUsage({ source: 'payg-selfhost', organization_id: 'org-payg' });
    const self = await rowOf('payg-selfhost');
    assert.deepEqual([self.billed_cost, self.currency], [null, 'USD']);
    assert.deepEqual(await outboxOf(self.id), []);
    await nextTick();
    assert.deepEqual(state.drained, []);
});

test('PAYG: a failed outbox write keeps the usage row and still tries the drain', async () => {
    await pg.exec('ALTER TABLE payg_meter_outbox RENAME TO payg_meter_outbox_away');
    try {
        await logUsage({ source: 'payg-outbox-down', organization_id: 'org-payg' });
    } finally {
        await pg.exec('ALTER TABLE payg_meter_outbox_away RENAME TO payg_meter_outbox');
    }
    const row = await rowOf('payg-outbox-down');
    near(row.billed_cost, 1.2);
    await nextTick();
    assert.deepEqual(state.drained, [`usage_${row.id}`]);
});

test('a row the database refuses is swallowed: the chat path never fails on usage logging', async () => {
    const before = await rowCount();
    await logUsage({ source: 'bad-row', duration_ms: /** @type {any} */ ('not a number') });
    assert.equal(await rowCount(), before);
});
