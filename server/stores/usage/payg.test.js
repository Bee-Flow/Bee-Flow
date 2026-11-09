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
const db = recordDb((sql) => (/SELECT sp\.currency/.test(sql) ? { rows: [{ currency }] } : undefined));
const payg = require('./payg');

beforeEach(() => { payg.invalidatePaygCache(null, null); db.reset(); currency = 'EUR'; });

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
