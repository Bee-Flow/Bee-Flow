/**
 * createUserWithSeatCheck: when the plan limit or the licence seat cap cannot be
 * read, no user is created; at the cap, nothing is inserted; and every
 * transaction gives its client back once.
 *
 * Against a real Postgres (the boot ladder's schema on PGlite,
 * testUtils/pgliteTemplate.js ladderPglite, behind db.js's pool). The plan
 * limit and the licence seat cap are stubbed: their failures are the subject
 * here, and their own stores have tests of their own.
 *
 * Run: cd server && node --test stores/user/usersCreate.seatCap.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { installResolveStub } = require('../../testUtils/stubRequire');

let limits = async () => ({ max_users: null });
let seats = async () => null;

const { usePglitePool } = require('../../testUtils/pglitePool');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const db = require('../../db');

const { pg, close } = usePglitePool(ladderPglite());

/** Every client the pool lent, so a test can see how each was given back. */
const clients = [];
const connect = db.pool.connect;
db.pool.connect = /** @type {any} */ (async () => {
    const raw = await connect();
    // As pg-pool lends it: a second release() throws, and a statement sent after
    // release is recorded, because by then the connection may serve another request.
    const client = {
        released: 0, afterRelease: /** @type {string[]} */ ([]),
        query: (/** @type {string} */ sql, /** @type {unknown[]} */ params) => {
            if (client.released) client.afterRelease.push(sql);
            return raw.query(sql, params);
        },
        release() {
            if (client.released++) throw new Error('Release called on client which has already been released to the pool.');
        },
    };
    clients.push(client);
    return client;
});

const restore = installResolveStub({
    './subscriptions': { getEffectiveLimits: (...a) => limits(...a) },
    '../../license/seats': { getMaxSeatsForOrg: (...a) => seats(...a) },
    './seatSyncPort': { syncSeatQuantity: async () => {} },
});
after(async () => { restore(); await close(); });

// The insert fails as the test says: `serialize` once with 40001 (counted on a
// sequence, which a rollback does not undo), `other` with a plain error.
const faults = pg.exec(`
    CREATE TABLE test_faults (name TEXT PRIMARY KEY);
    CREATE SEQUENCE test_insert_attempts;
    CREATE FUNCTION test_fail_user_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (SELECT 1 FROM test_faults WHERE name = 'serialize') AND nextval('test_insert_attempts') = 1 THEN
            RAISE EXCEPTION 'could not serialize access' USING ERRCODE = '40001';
        END IF;
        IF EXISTS (SELECT 1 FROM test_faults WHERE name = 'other') THEN
            RAISE EXCEPTION 'something else broke' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END $$;
    CREATE TRIGGER test_fail_user_insert BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION test_fail_user_insert();
`);


const { createUserWithSeatCheck, SeatCapExceededError } = require('./usersCreate');
const USER = { id: 'u1', username: 'u1', passwordHash: 'x', organizationId: 'o1' };

const userIds = async () => (await pg.query(`SELECT id FROM users WHERE "organizationId" = 'o1' ORDER BY id`)).rows.map(r => r.id);

/** Reset the table and set the caps. */
async function given({ activeUsers = 0, idExists = false, fault = null } = {}) {
    await faults;
    await require('./schema').initDB();
    await pg.exec(`DELETE FROM test_faults; ALTER SEQUENCE test_insert_attempts RESTART; DELETE FROM users WHERE "organizationId" IN ('o1', 'o2')`);
    for (let i = 0; i < activeUsers; i++) {
        await pg.query(`INSERT INTO users (id, username, "organizationId", status) VALUES ($1, $1, 'o1', 'active')`, [`seat${i}`]);
    }
    // Neither of these takes a seat.
    await pg.query(`INSERT INTO users (id, username, "organizationId", status) VALUES ('gone', 'gone', 'o1', 'disabled'), ('elsewhere', 'elsewhere', 'o2', 'active')`);
    if (idExists) await pg.query(`INSERT INTO users (id, username, "organizationId", status) VALUES ('u1', 'u1-old', 'o2', 'active')`);
    if (fault) await pg.query('INSERT INTO test_faults (name) VALUES ($1)', [fault]);
    clients.length = 0;
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

test('seat cap unreadable: strict throws 503 and nothing is inserted', async () => {
    await given();
    seats = async () => { throw new Error('db down'); };
    await assert.rejects(() => createUserWithSeatCheck(USER), (e) => e.status === 503 && e.code === 'seat_cap_unavailable');
    assert.deepEqual(await userIds(), ['gone']);
    assert.equal(clients.length, 0, 'no transaction was opened');
});

test('plan limit unreadable: non-strict returns limit_check_failed', async () => {
    await given();
    limits = async () => { throw new Error('db down'); };
    assert.deepEqual(await createUserWithSeatCheck(USER, { strict: false }), { created: false, reason: 'limit_check_failed' });
    assert.deepEqual(await userIds(), ['gone']);
});

test('both readable: the user is created', async () => {
    await given({ activeUsers: 4 });
    const r = await createUserWithSeatCheck(USER);
    assert.equal(r.created, true);
    assert.ok((await userIds()).includes('u1'));
    assertClientsReturnedCleanly();
});

// ── The transaction is ended once and the client is given back once ─────────

test('seat cap reached, strict: SeatCapExceededError reaches the caller and the client is returned once', async () => {
    await given({ activeUsers: 5 });
    await assert.rejects(() => createUserWithSeatCheck(USER), (e) => e instanceof SeatCapExceededError && e.current === 5 && e.max === 5);
    assert.ok(!(await userIds()).includes('u1'), 'nothing is inserted');
    assertClientsReturnedCleanly();
});

test('the lower of the two caps binds', async () => {
    // The default deployment mode is cloud, where the plan's cap binds too.
    await given({ activeUsers: 3 });
    limits = async () => ({ max_users: 3 });
    seats = async () => 5;
    assert.deepEqual(await createUserWithSeatCheck(USER, { strict: false }), { created: false, reason: 'seat_cap', current: 3, max: 3 });
    seats = async () => 3;
    limits = async () => ({ max_users: 10 });
    assert.deepEqual(await createUserWithSeatCheck(USER, { strict: false }), { created: false, reason: 'seat_cap', current: 3, max: 3 });
    seats = async () => 4;
    assert.equal((await createUserWithSeatCheck(USER, { strict: false })).created, true);
});

test('seat cap reached, non-strict: the batch is told seat_cap and the client is returned once', async () => {
    await given({ activeUsers: 5 });
    assert.deepEqual(await createUserWithSeatCheck(USER, { strict: false }), { created: false, reason: 'seat_cap', current: 5, max: 5 });
    assertClientsReturnedCleanly();
});

test('the id already exists: duplicate_id, nothing inserted, the client returned once', async () => {
    await given({ idExists: true });
    assert.deepEqual(await createUserWithSeatCheck(USER), { created: false, reason: 'duplicate_id' });
    assert.equal((await pg.query(`SELECT username FROM users WHERE id = 'u1'`)).rows[0].username, 'u1-old', 'the existing row is untouched');
    assertClientsReturnedCleanly();
});

test('a serialization failure is retried once on a fresh client', async () => {
    await given({ fault: 'serialize' });
    assert.deepEqual(await createUserWithSeatCheck(USER), { created: true, reason: null });
    assert.equal(clients.length, 2, 'the retry takes its own client');
    assert.ok((await userIds()).includes('u1'));
    assertClientsReturnedCleanly();
});

test('any other database error: create_failed, rolled back, the client returned once', async () => {
    await given({ fault: 'other' });
    const r = await createUserWithSeatCheck(USER);
    assert.equal(r.created, false);
    assert.equal(r.reason, 'create_failed');
    assert.ok(!(await userIds()).includes('u1'));
    assert.equal((await pg.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the session is not left inside an aborted transaction');
    assertClientsReturnedCleanly();
});
