/**
 * createUserWithSeatCheck: when the plan limit or the licence seat cap cannot be
 * read, no user is created. It used to carry on uncapped.
 *
 * Run: cd server && node --test --test-force-exit stores/user/usersCreate.seatCap.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { installResolveStub } = require('../../testUtils/stubRequire');

let limits = async () => ({ max_users: null });
let seats = async () => null;
const clientQueries = [];

const restore = installResolveStub({
    '../../db': {
        pool: {}, run: async () => ({ rowCount: 1 }), getOne: async () => null, getAll: async () => [],
        getClient: async () => ({
            query: async (sql) => { clientQueries.push(sql); return /COUNT\(\*\)/i.test(sql) ? { rows: [{ n: 0 }] } : { rows: [], rowCount: 0 }; },
            release() {},
        }),
    },
    './schema': { initDB: async () => {} },
    './subscriptions': { getEffectiveLimits: (...a) => limits(...a) },
    '../../license/seats': { getMaxSeatsForOrg: (...a) => seats(...a) },
    './seatSyncPort': { syncSeatQuantity: async () => {} },
});
after(restore);

const { createUserWithSeatCheck } = require('./usersCreate');
const USER = { id: 'u1', username: 'u1', passwordHash: 'x', organizationId: 'o1' };

test('seat cap unreadable: strict throws 503 and nothing is inserted', async () => {
    clientQueries.length = 0;
    seats = async () => { throw new Error('db down'); };
    await assert.rejects(() => createUserWithSeatCheck(USER), (e) => e.status === 503 && e.code === 'seat_cap_unavailable');
    assert.equal(clientQueries.length, 0);
});

test('plan limit unreadable: non-strict returns limit_check_failed', async () => {
    seats = async () => null;
    limits = async () => { throw new Error('db down'); };
    assert.deepEqual(await createUserWithSeatCheck(USER, { strict: false }), { created: false, reason: 'limit_check_failed' });
});

test('both readable: the user is created', async () => {
    limits = async () => ({ max_users: 10 });
    seats = async () => 5;
    const r = await createUserWithSeatCheck(USER);
    assert.equal(r.created, true);
});
