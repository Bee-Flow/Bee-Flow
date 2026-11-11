/**
 * The Azure service costs (azure_service_usage_log, KB embeddings among them)
 * are stored in USD; the AI usage figures of the same answer are in the plan
 * currency (stores/usage/logUsage.js converts every row). /summary adds the
 * two, and the dashboard shows the total with the plan currency's symbol, so
 * the USD part is converted into the plan currency first, and so are the
 * /azure-services/* figures.
 *
 * The real router, stores, plan-currency lookup and FX helper, on the recording
 * database of testUtils/routeHarness (no module mocks): the test answers the
 * queries for the usage rows, the plan's currency and the configured rate.
 *
 * Run: cd server && node --test routes/usage.azureCurrency.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.DEPLOYMENT_MODE = 'cloud';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');

const world = {
    plan: 'EUR',
    /** USD -> currency, as the config rows hold them */
    rates: /** @type {Record<string, string>} */ ({ currency_fx_usd_eur: '0.8' }),
};

/** @type {Array<[RegExp, () => Record<string, unknown>[]]>} */
const ANSWERS = [
    [/unique_services/, () => [{ total_calls: 4, total_cost: 10, total_tokens: 2000 }]],
    [/FROM azure_service_usage_log[\s\S]*GROUP BY service_type/, () => [{ service_type: 'embedding', calls: 3, total_cost: 5 }, { service_type: 'pii_detection', calls: 1, total_cost: 0 }]],
    [/FROM azure_service_usage_log[\s\S]*GROUP BY user_id/, () => [{ user_id: 'u1', calls: 3, total_cost: 5 }]],
    [/FROM azure_service_usage_log[\s\S]*GROUP BY period/, () => [{ period: '2026-11-01', calls: 3, total_cost: 2.5 }]],
    [/SELECT \* FROM azure_service_usage_log/, () => [{ id: 1, user_id: 'u1', service_type: 'embedding', estimated_cost: 1, metadata: { price_currency: 'EUR' } }]],
    // In the plan currency already: logUsage converted each row.
    [/total_estimated_cost[\s\S]*FROM ai_usage_log/, () => [{ total_calls: 2, total_tokens: 100, total_estimated_cost: 3 }]],
    [/SELECT sp\.currency/, () => [{ currency: world.plan }]],
    // The organisation the operator names with ?orgId exists.
    [/FROM organizations/, () => [{ id: 'org1', name: 'Example Org' }]],
];

const { api } = h.routeUnderTest(test, '/api/usage', () => require('./usage'), {
    answer: (sql, params) => {
        if (/FROM config WHERE key/.test(sql)) {
            const value = world.rates[String(params?.[0])];
            return value ? { rows: [{ value }] } : undefined;
        }
        const hit = ANSWERS.find(([pattern]) => pattern.test(sql));
        return hit ? { rows: hit[1]() } : undefined;
    },
    // The platform operator sees the raw figures (routes/usageRedact.js), Azure total included.
    user: { id: 'admin', organizationId: 'org1', role: 'admin' },
});

test.beforeEach(() => {
    world.plan = 'EUR';
    require('../stores/usage/payg').invalidatePaygCache(null, null);
});

// One organisation's figures: its plan currency is the one the answer is in.
const get = async (/** @type {string} */ pathname) => {
    const res = await api.call('GET', `/api/usage${pathname}?orgId=org1`);
    assert.strictEqual(res.status, 200, res.text);
    return res.body;
};
const close = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-9;

test('/summary converts the USD Azure total into the plan currency before adding it', async () => {
    const body = await get('/summary');
    assert.ok(close(body.azure_services_total_cost, 8), `USD 10 at 0.8 is EUR 8, got ${body.azure_services_total_cost}`);
    assert.ok(close(body.combined_total_cost, 3 + 8), `EUR 3 + EUR 8, got ${body.combined_total_cost}`);
});

test('/summary on a USD plan adds the USD figure as it is', async () => {
    world.plan = 'USD';
    const body = await get('/summary');
    assert.ok(close(body.combined_total_cost, 13), `got ${body.combined_total_cost}`);
});

test('a plan currency with no configured rate counts at 1.0, never fails the answer', async () => {
    world.plan = 'GBP';
    const body = await get('/summary');
    assert.ok(close(body.azure_services_total_cost, 10));
    assert.ok(close(body.combined_total_cost, 13));
});

test('the /azure-services figures are in the plan currency too, only their cost fields', async () => {
    const summary = await get('/azure-services/summary');
    assert.ok(close(summary.total_cost, 8));
    assert.strictEqual(summary.total_tokens, 2000);

    const byType = await get('/azure-services/by-type');
    assert.deepStrictEqual(byType.map((/** @type {any} */ row) => row.total_cost), [4, 0]);

    assert.ok(close((await get('/azure-services/by-user'))[0].total_cost, 4));
    assert.ok(close((await get('/azure-services/timeline'))[0].total_cost, 2));

    const [recent] = await get('/azure-services/recent');
    assert.ok(close(recent.estimated_cost, 0.8));
    assert.deepStrictEqual(recent.metadata, { price_currency: 'EUR' });
});
