// @typecheck
/**
 * The login throttle with its backing store DOWN: Redis is configured and
 * reported healthy, but every command fails (a dropped connection, a failover).
 *
 * The throttle must neither fail open (every guess goes through while Redis is
 * out) nor fail closed (nobody can sign in). Each storage call falls back to the
 * per-process in-memory store with the same limits, and says so with a warn
 * through utils/bestEffort, at most once a minute.
 *
 * Run: cd server && node --test auth/loginThrottle.storeDown.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const down = () => Promise.reject(new Error('ECONNRESET'));
let commands = 0;
const brokenRedis = {
    set: () => { commands++; return down(); },
    incr: () => { commands++; return down(); },
    get: () => { commands++; return down(); },
    pttl: () => { commands++; return down(); },
    del: () => { commands++; return down(); },
};
const throttle = require('./loginThrottle');
// "Ready" but failing every command: the throttle's own Redis seam, no module stubbing.
throttle._seam.redis = /** @type {import('ioredis').Redis} */ (/** @type {unknown} */ (brokenRedis));
after(() => { delete throttle._seam.redis; });

const log = require('../telemetry/log');
const { resetBestEffort, bestEffortCounts } = require('../utils/bestEffort');

const LABEL = 'loginThrottle:redis-fallback-memory';
const req = (ip = '203.0.113.9') => ({ ip, headers: {}, socket: { remoteAddress: ip } });

beforeEach(() => {
    throttle._resetMemory();
    resetBestEffort();
    commands = 0;
});

test('store down: a brute force against one account is still locked out at the same limit', async () => {
    const max = throttle.CONFIG.accountMaxFailures;
    let lockedAt = 0;
    for (let i = 1; i <= max + 5 && !lockedAt; i++) {
        if ((await throttle.recordLoginFailure(req(), 'victim')).locked) lockedAt = i;
    }
    assert.strictEqual(lockedAt, max, `locked after exactly ${max} failures`);
    assert.ok(commands > 0, 'the store was tried first');

    const check = await throttle.checkLoginAllowed(req(), 'victim');
    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.scope, 'account');
    assert.ok((check.retryAfterSec || 0) > 0);
    assert.ok((bestEffortCounts()[LABEL]?.count || 0) > 0, 'the fallback is counted');
});

test('store down: a normal sign-in still works, and a success clears the counter', async () => {
    assert.strictEqual((await throttle.checkLoginAllowed(req('198.51.100.4'), 'anna')).allowed, true);
    // A typo or two, then the right password.
    await throttle.recordLoginFailure(req('198.51.100.4'), 'anna');
    await throttle.recordLoginFailure(req('198.51.100.4'), 'anna');
    assert.strictEqual((await throttle.checkLoginAllowed(req('198.51.100.4'), 'anna')).allowed, true);
    await throttle.recordLoginSuccess(req('198.51.100.4'), 'anna');
    assert.strictEqual((await throttle.checkLoginAllowed(req('198.51.100.4'), 'anna')).allowed, true);

    // An account under attack elsewhere does not lock anybody else out.
    for (let i = 0; i < throttle.CONFIG.accountMaxFailures; i++) await throttle.recordLoginFailure(req(), 'victim');
    assert.strictEqual((await throttle.checkLoginAllowed(req(), 'victim')).allowed, false);
    assert.strictEqual((await throttle.checkLoginAllowed(req('198.51.100.4'), 'anna')).allowed, true);
});

test('store down: the fallback is logged at warn once a minute, not once per call', async () => {
    const warns = [];
    const realWarn = log.warn;
    log.warn = (...a) => { warns.push(a.map(String).join(' ')); };
    try {
        for (let i = 0; i < 5; i++) await throttle.recordLoginFailure(req(), `user${i}`);
    } finally {
        log.warn = realWarn;
    }
    const fallbackWarns = warns.filter((w) => w.includes(LABEL));
    assert.strictEqual(fallbackWarns.length, 1, `one warn for many failed store calls, got ${fallbackWarns.length}`);
    assert.ok(bestEffortCounts()[LABEL].count > 5, 'every failed store call is still counted');
});
