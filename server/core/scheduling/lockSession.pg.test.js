// @typecheck strict
/**
 * core/scheduling/lockSession.js against a REAL Postgres, with two pools
 * standing in for two replicas. PGlite is one session, so what a session
 * advisory lock is for (one holder among several connections) cannot be shown
 * there; the bookkeeping is in ./lockSession.test.js.
 *
 *   - mutual exclusion: while replica A is inside a pass, replica B is refused,
 *     and gets the lock once A is done;
 *   - release on failure: a pass that throws leaves the lock free;
 *   - one connection: two locks held at once sit on ONE backend, and the pool
 *     has nothing checked out afterwards;
 *   - the re-entrancy trap: Postgres grants a held key again to the same
 *     session, the lock session refuses it;
 *   - a dead lock connection: the lock is free at once, the running pass
 *     finishes, and the next lock gets a fresh connection;
 *   - a retired lock connection that is still alive (a statement failed on it,
 *     or was answered after the time-out): a pass that finishes there leaves
 *     its lock free for both replicas, the pass still running keeps its own,
 *     and a lock granted after its caller gave up is given back.
 *
 * Needs CORE_DATABASE_URL; skips without a reachable Postgres, fails without
 * one under REQUIRE_POSTGRES=1 (`npm run test:postgres`, ci.yml's
 * server-postgres job). It creates no tables.
 *
 * Run: CORE_DATABASE_URL=postgresql://… node --test core/scheduling/lockSession.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const { createLockSession } = require('./lockSession');
const { postgresSkipReason } = require('../../testUtils/requirePostgres');

// Keys of this test only; a number and a name.
const KEY = 0x7E57_10C;
const OTHER_KEY = 0x7E57_10D;
const NAME = 'beeflow:test:lock-session';

const url = process.env.CORE_DATABASE_URL || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_core';
/** @type {import('pg').Pool} */
let poolA;
/** @type {import('pg').Pool} */
let poolB;
let skipReason = '';

before(async () => {
    poolA = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000 });
    poolB = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000 });
    // An idle client whose backend is terminated emits on the pool.
    poolA.on('error', () => {});
    poolB.on('error', () => {});
    try {
        await poolA.query('SELECT 1');
    } catch (e) {
        skipReason = postgresSkipReason('lockSession.pg.test', e);
    }
});

after(async () => {
    await Promise.all([poolA.end(), poolB.end()]);
});

/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
function onPostgres(name, fn) {
    test(name, async (t) => {
        if (skipReason) { t.skip(skipReason); return; }
        try {
            await fn();
        } finally {
            // A failed assertion must not leave a pass waiting on its gate: the pass would keep
            // its lock and its pool connection, and the `after` hook would wait for it forever.
            for (const open of gates.splice(0)) open();
        }
    });
}

/** @type {(() => void)[]} the gates of the running test */
const gates = [];

/** A promise and the function that resolves it. */
function gate() {
    /** @type {() => void} */
    let open = () => {};
    const closed = new Promise((resolve) => { open = () => resolve(undefined); });
    gates.push(open);
    return { closed, open };
}

/** The backends that hold a session advisory lock on one of this test's numeric keys. */
async function holders() {
    const { rows } = await poolB.query(
        `SELECT pid, objid::bigint AS key FROM pg_locks WHERE locktype = 'advisory' AND granted AND objid = ANY($1::oid[]) ORDER BY objid`,
        [[KEY, OTHER_KEY]],
    );
    return rows.map((r) => ({ pid: r.pid, key: Number(r.key) }));
}

const checkedOut = (/** @type {import('pg').Pool} */ pool) => pool.totalCount - pool.idleCount;

onPostgres('two replicas: B is refused while A is inside the pass, and gets the lock when A is done', async () => {
    const a = createLockSession({ pool: poolA });
    const b = createLockSession({ pool: poolB });
    const hold = gate();
    const order = /** @type {string[]} */ ([]);
    const passA = a.withSessionLock(KEY, async () => { order.push('A in'); await hold.closed; order.push('A out'); return 'a'; });
    while (order.length === 0) await new Promise((r) => setTimeout(r, 5));

    assert.deepStrictEqual(await b.withSessionLock(KEY, async () => { order.push('B'); }), { ran: false });
    assert.strictEqual((await holders()).length, 1, 'exactly one backend holds the key');

    hold.open();
    assert.deepStrictEqual(await passA, { ran: true, value: 'a' });
    assert.deepStrictEqual(await holders(), [], 'released');
    assert.deepStrictEqual(await b.withSessionLock(KEY, async () => { order.push('B'); return 'b'; }), { ran: true, value: 'b' });
    assert.deepStrictEqual(order, ['A in', 'A out', 'B']);
});

onPostgres('a pass that throws leaves the lock free for the other replica', async () => {
    const a = createLockSession({ pool: poolA });
    const b = createLockSession({ pool: poolB });
    await assert.rejects(a.withSessionLock(KEY, async () => { throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual(await holders(), []);
    assert.deepStrictEqual(await b.withSessionLock(KEY, async () => 'b'), { ran: true, value: 'b' });
    // By name as well: hashtext() on both sides.
    await assert.rejects(a.withSessionLock(NAME, async () => { throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual(await b.withSessionLock(NAME, async () => 'named'), { ran: true, value: 'named' });
});

onPostgres('two locks held at once sit on ONE backend, and nothing stays checked out', async () => {
    const a = createLockSession({ pool: poolA });
    const first = gate();
    const second = gate();
    const before = checkedOut(poolA);
    const one = a.withSessionLock(KEY, () => first.closed);
    const two = a.withSessionLock(OTHER_KEY, () => second.closed);
    while ((await holders()).length < 2) await new Promise((r) => setTimeout(r, 5));

    const held = await holders();
    assert.deepStrictEqual(held.map((h) => h.key), [KEY, OTHER_KEY]);
    assert.strictEqual(held[0].pid, held[1].pid, 'both locks are on the same backend');
    assert.strictEqual(checkedOut(poolA), before + 1, 'one pool connection for two passes');

    first.open();
    await one;
    assert.deepStrictEqual((await holders()).map((h) => h.key), [OTHER_KEY], 'the other lock is untouched');
    second.open();
    await two;
    assert.deepStrictEqual(await holders(), []);
    assert.strictEqual(checkedOut(poolA), before, 'the connection went back to the pool');
});

onPostgres('the re-entrancy trap: Postgres grants a held key to the same session, the lock session refuses it', async () => {
    // What Postgres does, on one connection.
    const client = await poolB.connect();
    try {
        const again = await client.query('SELECT pg_try_advisory_lock($1) AS one, pg_try_advisory_lock($1) AS two', [OTHER_KEY]);
        assert.deepStrictEqual(again.rows[0], { one: true, two: true });
        await client.query('SELECT pg_advisory_unlock($1), pg_advisory_unlock($1)', [OTHER_KEY]);
    } finally {
        client.release();
    }
    // What the lock session does with a second pass of the same job in this process.
    const a = createLockSession({ pool: poolA });
    const hold = gate();
    let inside = 0;
    const pass = a.withSessionLock(KEY, async () => { inside += 1; await hold.closed; });
    while (inside === 0) await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual(await a.withSessionLock(KEY, async () => { inside += 1; }), { ran: false });
    assert.strictEqual(inside, 1);
    hold.open();
    await pass;
});

onPostgres('the lock connection dies: the lock is free at once, the pass finishes, the next lock gets a fresh connection', async () => {
    const a = createLockSession({ pool: poolA });
    const b = createLockSession({ pool: poolB });
    const hold = gate();
    let inside = false;
    const pass = a.withSessionLock(KEY, async () => { inside = true; await hold.closed; return 'finished'; });
    while (!inside) await new Promise((r) => setTimeout(r, 5));

    const [{ pid }] = await holders();
    await poolB.query('SELECT pg_terminate_backend($1)', [pid]);
    while ((await holders()).length > 0) await new Promise((r) => setTimeout(r, 5));
    // Same semantics as a borrowed connection that dies: the other replica may start.
    assert.deepStrictEqual(await b.withSessionLock(KEY, async () => 'b'), { ran: true, value: 'b' });

    hold.open();
    assert.deepStrictEqual(await pass, { ran: true, value: 'finished' }, 'the running pass is not interrupted');
    const next = await a.withSessionLock(OTHER_KEY, async () => (await holders())[0].pid);
    assert.ok(next.ran && next.value !== pid, 'a fresh backend');
    assert.deepStrictEqual(await holders(), []);
});

onPostgres('a statement fails on a connection that stays alive: a finished pass still frees its lock there, the running one keeps its own', async () => {
    const a = createLockSession({ pool: poolA });
    const b = createLockSession({ pool: poolB });
    const long = gate();
    const short = gate();
    let inside = 0;
    const longPass = a.withSessionLock(KEY, async () => { inside += 1; await long.closed; });
    const shortPass = a.withSessionLock(OTHER_KEY, async () => { inside += 1; await short.closed; });
    while (inside < 2) await new Promise((r) => setTimeout(r, 5));
    const [{ pid }] = await holders();

    // 1.5 is no bigint: the statement fails and the connection is fine. It is retired all the same.
    await assert.rejects(a.withSessionLock(1.5, async () => 'never'), /bigint/);
    assert.deepStrictEqual(await holders(), [{ pid, key: KEY }, { pid, key: OTHER_KEY }], 'both passes still hold their lock');

    short.open();
    await shortPass;
    assert.deepStrictEqual(await holders(), [{ pid, key: KEY }], 'the finished pass left nothing behind on the retired connection');
    // Its next tick runs, here and on the other replica, while the long pass is still busy.
    const next = await a.withSessionLock(OTHER_KEY, async () => (await holders()).filter((h) => h.key === OTHER_KEY).map((h) => h.pid));
    assert.ok(next.ran && next.value.length === 1 && next.value[0] !== pid, 'on a fresh connection');
    assert.deepStrictEqual(await b.withSessionLock(OTHER_KEY, async () => 'b'), { ran: true, value: 'b' });
    assert.deepStrictEqual(await b.withSessionLock(KEY, async () => 'b'), { ran: false }, 'the running pass still excludes the other replica');

    long.open();
    await longPass;
    assert.deepStrictEqual(await holders(), []);
});

onPostgres('a lock statement answered after the time-out: the late grant is given back, not left on the retired connection', async () => {
    // The lock statement of OTHER_KEY waits behind a pg_sleep on the same connection, as a stalled
    // server would make it wait: the caller gives up first, Postgres grants the lock afterwards.
    /** @type {Promise<{ rows: any[] }> | undefined} */
    let lateAnswer;
    const slowPool = {
        connect: async () => {
            const client = await poolA.connect();
            return {
                query: (/** @type {string} */ sql, /** @type {any[] | undefined} */ params) => {
                    if (!(params && params[0] === OTHER_KEY && sql.includes('pg_try_advisory_lock'))) return client.query(sql, params);
                    lateAnswer = client.query('SELECT pg_sleep(1)').then(() => client.query(sql, params));
                    return lateAnswer;
                },
                release: (/** @type {Error | boolean | undefined} */ err) => client.release(err),
                on: (/** @type {'error'} */ event, /** @type {(err: Error) => void} */ fn) => client.on(event, fn),
                removeListener: (/** @type {'error'} */ event, /** @type {(err: Error) => void} */ fn) => client.removeListener(event, fn),
            };
        },
    };
    const a = createLockSession({ pool: slowPool, statementTimeoutMs: 50 });
    const b = createLockSession({ pool: poolB });
    const hold = gate();
    let inside = false;
    const pass = a.withSessionLock(KEY, async () => { inside = true; await hold.closed; });
    while (!inside) await new Promise((r) => setTimeout(r, 5));

    let ran = false;
    await assert.rejects(a.withSessionLock(OTHER_KEY, async () => { ran = true; }), /did not answer within 50 ms/);
    // Postgres does grant it, on the connection the running pass keeps open.
    const answer = await lateAnswer;
    assert.strictEqual(answer?.rows[0].locked, true);
    assert.strictEqual(ran, false, 'no pass runs under a lock nobody waited for');
    const deadline = Date.now() + 5000;
    while ((await holders()).some((h) => h.key === OTHER_KEY) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual((await holders()).map((h) => h.key), [KEY], 'only the running pass holds a lock');
    assert.deepStrictEqual(await b.withSessionLock(OTHER_KEY, async () => 'b'), { ran: true, value: 'b' });

    hold.open();
    await pass;
    assert.deepStrictEqual(await holders(), []);
});
