/**
 * createUserWithSeatCheck: when the plan limit or the licence seat cap cannot be
 * read, no user is created. It used to carry on uncapped.
 *
 * Run: cd server && node --test stores/user/usersCreate.seatCap.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { installResolveStub } = require('../../testUtils/stubRequire');

let limits = async () => ({ max_users: null });
let seats = async () => null;
const clientQueries = [];
/** What the pooled client answers: the active-user count, whether the id exists, and an error to raise on INSERT. */
let world = { activeUsers: 0, idExists: false, insertError: null };
/** Every client handed out, so a test can see how each was given back. */
const clients = [];

/**
 * A pooled client as pg-pool lends it: a second release() throws, and a statement sent after
 * release is recorded, because by then the connection may be serving another request.
 */
function lendClient() {
    const client = {
        released: 0, afterRelease: [],
        query: async (sql) => {
            if (client.released) client.afterRelease.push(sql);
            clientQueries.push(sql);
            if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ n: world.activeUsers }] };
            if (/^SELECT id FROM users/i.test(sql)) return { rows: world.idExists ? [{ id: 'u1' }] : [], rowCount: world.idExists ? 1 : 0 };
            if (/^\s*INSERT INTO users/i.test(sql) && world.insertError) { const e = world.insertError; world.insertError = null; throw e; }
            return { rows: [], rowCount: 0 };
        },
        release() {
            if (client.released++) throw new Error('Release called on client which has already been released to the pool.');
        },
    };
    clients.push(client);
    return client;
}

const restore = installResolveStub({
    '../../db': {
        pool: {}, run: async () => ({ rowCount: 1 }), getOne: async () => null, getAll: async () => [],
        getClient: async () => lendClient(),
        // db.withTransaction's contract: BEGIN, the callback, COMMIT; ROLLBACK on a throw; one release.
        withTransaction: async (fn) => {
            const client = lendClient();
            try {
                await client.query('BEGIN');
                const out = await fn(client);
                await client.query('COMMIT');
                return out;
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        },
    },
    './schema': { initDB: async () => {} },
    './subscriptions': { getEffectiveLimits: (...a) => limits(...a) },
    '../../license/seats': { getMaxSeatsForOrg: (...a) => seats(...a) },
    './seatSyncPort': { syncSeatQuantity: async () => {} },
});
after(restore);

const { createUserWithSeatCheck, SeatCapExceededError } = require('./usersCreate');
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

// ── The transaction is ended once and the client is given back once ─────────

/** Reset the recording and set what the database answers. */
function given(next) {
    clientQueries.length = 0;
    clients.length = 0;
    world = { activeUsers: 0, idExists: false, insertError: null, ...next };
    limits = async () => ({ max_users: 10 });
    seats = async () => 5;
}

/** Every client was released exactly once and nothing was sent on it afterwards. */
function assertClientsReturnedCleanly() {
    assert.ok(clients.length > 0, 'a client was lent');
    for (const c of clients) {
        assert.equal(c.released, 1, 'the client is released exactly once');
        assert.deepEqual(c.afterRelease, [], 'no statement is sent on a client that was already given back');
    }
}

test('seat cap reached, strict: SeatCapExceededError reaches the caller and the client is returned once', async () => {
    given({ activeUsers: 5 });
    await assert.rejects(() => createUserWithSeatCheck(USER), (e) => e instanceof SeatCapExceededError && e.current === 5 && e.max === 5);
    assert.ok(!clientQueries.some((q) => /INSERT INTO users/i.test(q)), 'nothing is inserted');
    assertClientsReturnedCleanly();
});

test('seat cap reached, non-strict: the batch is told seat_cap and the client is returned once', async () => {
    given({ activeUsers: 5 });
    assert.deepEqual(await createUserWithSeatCheck(USER, { strict: false }), { created: false, reason: 'seat_cap', current: 5, max: 5 });
    assertClientsReturnedCleanly();
});

test('the id already exists: duplicate_id, nothing inserted, the client returned once', async () => {
    given({ idExists: true });
    assert.deepEqual(await createUserWithSeatCheck(USER), { created: false, reason: 'duplicate_id' });
    assert.ok(!clientQueries.some((q) => /INSERT INTO users/i.test(q)), 'nothing is inserted');
    assertClientsReturnedCleanly();
});

test('a serialization failure is retried once on a fresh client', async () => {
    given({ insertError: Object.assign(new Error('could not serialize access'), { code: '40001' }) });
    assert.deepEqual(await createUserWithSeatCheck(USER), { created: true, reason: null });
    assert.equal(clients.length, 2, 'the retry takes its own client');
    assert.equal(clientQueries.filter((q) => /INSERT INTO users/i.test(q)).length, 2);
    assertClientsReturnedCleanly();
});

test('any other database error: create_failed, rolled back, the client returned once', async () => {
    given({ insertError: Object.assign(new Error('duplicate key value'), { code: '23505' }) });
    const r = await createUserWithSeatCheck(USER);
    assert.equal(r.created, false);
    assert.equal(r.reason, 'create_failed');
    assert.ok(clientQueries.includes('ROLLBACK'));
    assertClientsReturnedCleanly();
});
