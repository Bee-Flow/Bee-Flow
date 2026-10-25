'use strict';

/**
 * checkResourceLimits('users'): an unreadable licence seat cap must not read as
 * "no cap". It answers 503 instead of letting a seat-licensed org add users.
 *
 * Run: cd server && node --test --test-force-exit core/entitlements/limits.seatCap.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const userStore = require('../../stores/userStore');
const license = require('../../license/index');
const { checkResourceLimits } = require('./limits');

test('a failing seat-cap lookup throws 503 instead of allowing the user', async (t) => {
    t.mock.method(userStore, 'getEffectiveLimits', async () => ({ max_users: null }));
    t.mock.method(license, 'getMaxSeatsForOrg', async () => { throw new Error('db down'); });
    await assert.rejects(() => checkResourceLimits('o1', 'users', 3), (e) => e.status === 503 && e.code === 'seat_cap_unavailable');
});

test('a readable seat cap still blocks at the cap and allows below it', async (t) => {
    t.mock.method(userStore, 'getEffectiveLimits', async () => ({ max_users: null }));
    t.mock.method(license, 'getMaxSeatsForOrg', async () => 5);
    assert.match(await checkResourceLimits('o1', 'users', 5), /limit of 5 users/);
    assert.equal(await checkResourceLimits('o1', 'users', 4), null);
});
