'use strict';

/**
 * license/refresh.js as a scheduler: what start() plans, that a second start()
 * plans nothing more, and that stop() ends it. Time is the test runner's
 * clock; the store and the revocation cursor are stand-ins that count.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test license/refresh.scheduler.test.js
 */

process.env.NODE_ENV = 'test';
process.env.LICENSE_REFRESH_URL = 'https://license.example.test/v1/refresh';
process.env.LICENSE_CRL_URL = 'https://license.example.test/v1/crl';
delete process.env.LICENSE_REFRESH_DISABLED;
delete process.env.LICENSE_REFRESH_INTERVAL_SECONDS;
delete process.env.LICENSE_CRL_INTERVAL_SECONDS;

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('./store');
const refresh = require('./refresh');
const configStore = require('../stores/configStore');

const SECOND = 1000;

test('before start() nothing is enabled and nothing is marked as switched off', () => {
    const health = refresh.getRefresherHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.disabledByEnv, false);
    assert.equal(health.crl.enabled, false);
});

test('start() plans a first run and an interval for both loops, once; stop() ends them', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const refreshRuns = t.mock.method(store, 'getLicensesNeedingRefresh', async () => []);
    // The revocation loop reads its cursor first; the stand-in stops it there.
    const crlRuns = t.mock.method(configStore, 'getConfig', async () => { throw new Error('no cursor in this test'); });
    const runs = () => [refreshRuns.mock.callCount(), crlRuns.mock.callCount()];

    refresh.start();
    t.after(() => refresh.stop());
    assert.equal(refresh.getRefresherHealth().enabled, true);
    assert.equal(refresh.getRefresherHealth().crl.enabled, true);
    assert.deepEqual(runs(), [0, 0], 'nothing runs at start itself');

    t.mock.timers.tick(30 * SECOND);
    assert.deepEqual(runs(), [1, 0], 'the first refresh half a minute after boot');
    t.mock.timers.tick(15 * SECOND);
    assert.deepEqual(runs(), [1, 1], 'the first revocation poll at 45 seconds');
    t.mock.timers.tick(900 * SECOND - 45 * SECOND);
    assert.deepEqual(runs(), [1, 2], 'the revocation poll every quarter of an hour');
    t.mock.timers.tick(2700 * SECOND);
    assert.deepEqual(runs(), [2, 5], 'the refresh every hour');

    refresh.start();
    t.mock.timers.tick(3600 * SECOND);
    assert.deepEqual(runs(), [3, 9], 'a second start() plans nothing more');

    refresh.stop();
    t.mock.timers.tick(2 * 3600 * SECOND);
    assert.deepEqual(runs(), [3, 9], 'nothing runs after stop()');

    refresh.start();
    t.mock.timers.tick(30 * SECOND);
    assert.deepEqual(runs(), [4, 9], 'and start() after stop() plans again');
});
