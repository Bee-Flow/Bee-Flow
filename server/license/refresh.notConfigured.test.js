'use strict';

/**
 * license/refresh.js on an install that names no licence server: a licence is
 * left alone (its own expiry and signature decide), and start() plans nothing.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test license/refresh.notConfigured.test.js
 */

process.env.NODE_ENV = 'test';
delete process.env.LICENSE_REFRESH_URL;
delete process.env.LICENSE_CRL_URL;
delete process.env.LICENSE_REFRESH_DISABLED;

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('./store');
const refresh = require('./refresh');

test('without a licence server a monthly licence is skipped, not failed', async (t) => {
    const failures = t.mock.method(store, 'markRefreshFailure', async () => {});
    const asked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no request expected'); });
    const out = await refresh.refreshOne({ id: 'lic-1', billingInterval: 'monthly', issuer: 'https://license.example.test' });
    assert.deepEqual(out, { skipped: true, reason: 'license_server_not_configured' });
    assert.equal(asked.mock.callCount(), 0);
    assert.equal(failures.mock.callCount(), 0);
});

test('without a licence server start() plans no refresh and no revocation poll', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const due = t.mock.method(store, 'getLicensesNeedingRefresh', async () => []);
    refresh.start();
    t.after(() => refresh.stop());
    t.mock.timers.tick(2 * 3600 * 1000);
    assert.equal(due.mock.callCount(), 0);
    const health = refresh.getRefresherHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.crl.enabled, false);
    assert.equal(health.disabledByEnv, false);
});
