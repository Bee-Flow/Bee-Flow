// @typecheck
/**
 * usage/payg: the per-subscriber cache and its invalidation.
 *
 * The plan currency shares the PAYG cache map under a `cur:` key, but
 * invalidatePaygCache(orgId) dropped only the PAYG target. After a plan change
 * (setOrgSubscription calls it for exactly that) the old plan's currency kept
 * being served, so usage rows were converted to the wrong currency until the
 * entry aged out.
 *
 * Run: cd server && node --test stores/usage/payg.test.js
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DEPLOYMENT_MODE = 'cloud';

const { recordDb } = require('../../testUtils/routeHarness');

let currency = 'EUR';
/** @type {Error | null} */
let dbDown = null;
const METERED = { stripe_customer_id: 'cus_1', status: 'active', billing_model: 'metered', markup_percent: '20', stripe_meter_event_name: 'beeflow_payg_usage', currency: 'usd' };
const db = recordDb((sql) => {
    if (dbDown) throw dbDown;
    if (/SELECT sp\.currency/.test(sql)) return { rows: [{ currency }] };
    return /stripe_meter_event_name/.test(sql) ? { rows: [METERED] } : undefined;
});
const payg = require('./payg');

beforeEach(() => { payg.invalidatePaygCache(null, null); db.reset(); currency = 'EUR'; dbDown = null; });

test('a plan change for an organisation drops its cached currency', async () => {
    assert.equal(await payg._resolvePlanCurrency('org1', null), 'EUR');
    currency = 'USD';
    assert.equal(await payg._resolvePlanCurrency('org1', null), 'EUR', 'served from the cache');
    payg.invalidatePaygCache('org1', null);
    assert.equal(await payg._resolvePlanCurrency('org1', null), 'USD');
});

test('a plan change for a consumer drops their cached currency, and nobody else\'s', async () => {
    assert.equal(await payg._resolvePlanCurrency(null, 'u1'), 'EUR');
    assert.equal(await payg._resolvePlanCurrency(null, 'u2'), 'EUR');
    currency = 'GBP';
    payg.invalidatePaygCache(null, 'u1');
    assert.equal(await payg._resolvePlanCurrency(null, 'u1'), 'GBP');
    assert.equal(await payg._resolvePlanCurrency(null, 'u2'), 'EUR', 'another subscriber keeps its entry');
});

// A lookup that fails used to be cached like an answer: for the next minute a
// metered subscriber counted as "not pay-as-you-go", and every call in that
// minute was logged without a billed cost and without a meter event.
test('a failed lookup is not remembered: the next call of a metered subscriber is billed again', async () => {
    dbDown = new Error('connection terminated');
    assert.equal(await payg._resolvePaygTarget('org1', null), null, 'no target while the lookup fails');
    assert.equal(await payg._resolvePaygTarget(null, 'u1'), null);

    dbDown = null;
    const target = { stripeCustomerId: 'cus_1', markupPercent: 20, meterEventName: 'beeflow_payg_usage', currency: 'USD' };
    assert.deepEqual(await payg._resolvePaygTarget('org1', null), target);
    assert.deepEqual(await payg._resolvePaygTarget(null, 'u1'), target);

    db.reset();
    assert.deepEqual(await payg._resolvePaygTarget('org1', null), target);
    assert.equal(db.queries.length, 0, 'an answer is still cached');
});

test('a failed currency lookup falls back to EUR for that call only', async () => {
    currency = 'USD';
    dbDown = new Error('connection terminated');
    assert.equal(await payg._resolvePlanCurrency('org1', null), 'EUR');
    dbDown = null;
    assert.equal(await payg._resolvePlanCurrency('org1', null), 'USD');
});
