// @typecheck strict
/**
 * core/scheduling/lockSession.js against a pool double: the bookkeeping that
 * sharing one session needs. What Postgres itself does between two sessions is
 * in ./lockSession.pg.test.js.
 *
 *   - one connection for every lock held at the same time, returned after the last;
 *   - a key already in flight in this process is refused before Postgres is
 *     asked (a session lock is re-entrant, Postgres would say yes);
 *   - the lock is released when the pass throws;
 *   - a connection a statement failed on is closed, not reused;
 *   - while it is still open for the passes that run on it, each of them gives
 *     its own lock back there, and so does a lock granted after its caller gave up;
 *   - a connection that is dead is not asked to unlock.
 *
 * Run: node --test core/scheduling/lockSession.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createLockSession } = require('./lockSession');

/**
 * A pool whose clients grant every lock, like a session that already holds it would.
 * @param {{ onQuery?: (sql: string, params: any[] | undefined, client: any) => Promise<{ rows: any[] }> | undefined, connect?: () => Promise<any> }} [opts]
 */
function fakePool({ onQuery, connect } = {}) {
    /** @type {{ connects: number, released: (Error | boolean | undefined)[], queries: string[], clients: any[] }} */
    const seen = { connects: 0, released: [], queries: [], clients: [] };
    const pool = {
        connect: async () => {
            seen.connects += 1;
            if (connect) return connect();
            /** @type {Record<string, (err: Error) => void>} */
            const listeners = {};
            const client = {
                listeners,
                query: async (/** @type {string} */ sql, /** @type {any[] | undefined} */ params) => {
                    seen.queries.push(`${sql.includes('unlock') ? 'unlock' : 'lock'}:${params && params[0]}`);
                    const override = onQuery && onQuery(sql, params, client);
                    if (override) return override;
                    return { rows: [{ locked: true }] };
                },
                release: (/** @type {Error | boolean | undefined} */ err) => { seen.released.push(err); },
                on: (/** @type {string} */ event, /** @type {(err: Error) => void} */ fn) => { listeners[event] = fn; },
                removeListener: (/** @type {string} */ event) => { delete listeners[event]; },
            };
            seen.clients.push(client);
            return client;
        },
    };
    return { pool, seen };
}

/** A promise and the function that resolves it. */
function gate() {
    /** @type {() => void} */
    let open = () => {};
    const closed = new Promise((resolve) => { open = () => resolve(undefined); });
    return { closed, open };
}

test('a pass runs under its lock, gets its value back, and the connection goes back to the pool', async () => {
    const { pool, seen } = fakePool();
    const session = createLockSession({ pool });
    assert.deepStrictEqual(await session.withSessionLock(7, async () => 'done'), { ran: true, value: 'done' });
    assert.deepStrictEqual(seen.queries, ['lock:7', 'unlock:7']);
    assert.deepStrictEqual(seen.released, [undefined], 'returned to the pool, not closed');
    assert.deepStrictEqual(session.stats(), { inFlight: 0, connected: false, users: 0 });
});

test('locks held at the same time share ONE connection; it is returned after the last', async () => {
    const { pool, seen } = fakePool();
    const session = createLockSession({ pool });
    const a = gate();
    const b = gate();
    const first = session.withSessionLock(1, () => a.closed);
    const second = session.withSessionLock('beeflow:job:two', () => b.closed);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(seen.connects, 1, 'the second lock did not take a connection of its own');
    assert.deepStrictEqual(session.stats(), { inFlight: 2, connected: true, users: 2 });
    a.open();
    await first;
    assert.deepStrictEqual(seen.released, [], 'still carrying the second lock');
    b.open();
    await second;
    assert.deepStrictEqual(seen.released, [undefined]);
    assert.deepStrictEqual(seen.queries, ['lock:1', 'lock:beeflow:job:two', 'unlock:1', 'unlock:beeflow:job:two']);
    // A later pass starts over with a connection from the pool.
    await session.withSessionLock(1, async () => {});
    assert.strictEqual(seen.connects, 2);
});

test('a key in flight in this process is refused without asking Postgres', async () => {
    // The double grants every lock, as Postgres does for a key the SAME session
    // holds. Without the in-flight set both passes would run.
    const { pool, seen } = fakePool();
    const session = createLockSession({ pool });
    const hold = gate();
    let secondRan = false;
    const first = session.withSessionLock(42, () => hold.closed);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(await session.withSessionLock(42, async () => { secondRan = true; }), { ran: false });
    assert.strictEqual(secondRan, false);
    assert.deepStrictEqual(seen.queries, ['lock:42'], 'no second lock statement');
    hold.open();
    await first;
    // The number 42 and the name '42' are different keys.
    assert.deepStrictEqual(await session.withSessionLock(42, async () => 1), { ran: true, value: 1 });
});

test('another holder: the pass does not run and nothing is unlocked', async () => {
    const { pool, seen } = fakePool({ onQuery: (sql) => (sql.includes('unlock') ? undefined : Promise.resolve({ rows: [{ locked: false }] })) });
    const session = createLockSession({ pool });
    let ran = false;
    assert.deepStrictEqual(await session.withSessionLock(5, async () => { ran = true; }), { ran: false });
    assert.strictEqual(ran, false);
    assert.deepStrictEqual(seen.queries, ['lock:5']);
    assert.deepStrictEqual(seen.released, [undefined]);
});

test('a pass that throws still releases its lock, and the error reaches the caller', async () => {
    const { pool, seen } = fakePool();
    const session = createLockSession({ pool });
    await assert.rejects(session.withSessionLock(9, async () => { throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual(seen.queries, ['lock:9', 'unlock:9']);
    assert.deepStrictEqual(seen.released, [undefined]);
    assert.deepStrictEqual(await session.withSessionLock(9, async () => 'again'), { ran: true, value: 'again' });
});

test('the connection dies under a running pass: the pass finishes, no unlock is sent, the connection is closed', async () => {
    const { pool, seen } = fakePool();
    const session = createLockSession({ pool });
    const hold = gate();
    const pass = session.withSessionLock(3, async () => { await hold.closed; return 'finished'; });
    await new Promise((r) => setImmediate(r));
    seen.clients[0].listeners.error(new Error('Connection terminated unexpectedly'));
    // A new lock does not go on the dead connection.
    assert.deepStrictEqual(await session.withSessionLock(4, async () => 'fresh'), { ran: true, value: 'fresh' });
    assert.strictEqual(seen.connects, 2);
    hold.open();
    assert.deepStrictEqual(await pass, { ran: true, value: 'finished' });
    assert.deepStrictEqual(seen.queries, ['lock:3', 'lock:4', 'unlock:4'], 'no unlock on the dead connection');
    assert.deepStrictEqual(seen.released, [undefined, true], 'the dead connection was closed, not returned');
});

test('a failing lock statement reaches the caller and closes the connection', async () => {
    const { pool, seen } = fakePool({ onQuery: () => Promise.reject(new Error('socket hang up')) });
    const session = createLockSession({ pool });
    await assert.rejects(session.withSessionLock(8, async () => 'never'), /socket hang up/);
    assert.deepStrictEqual(seen.released, [true]);
    assert.deepStrictEqual(session.stats(), { inFlight: 0, connected: false, users: 0 });
});

test('a failing unlock is best-effort for the pass, and the connection is not reused', async () => {
    const { pool, seen } = fakePool({ onQuery: (sql) => (sql.includes('unlock') ? Promise.reject(new Error('gone')) : undefined) });
    const session = createLockSession({ pool });
    assert.deepStrictEqual(await session.withSessionLock(6, async () => 'value'), { ran: true, value: 'value' });
    assert.deepStrictEqual(seen.released, [true], 'closing it is what frees the lock');
});

test('a lock statement that never answers times out, for everyone queued behind it', async () => {
    const { pool, seen } = fakePool({ onQuery: () => new Promise(() => {}) });
    const session = createLockSession({ pool, statementTimeoutMs: 30 });
    const results = await Promise.allSettled([session.withSessionLock(1, async () => 1), session.withSessionLock(2, async () => 2)]);
    assert.deepStrictEqual(results.map((r) => r.status), ['rejected', 'rejected']);
    assert.match(String(/** @type {PromiseRejectedResult} */ (results[0]).reason.message), /did not answer within 30 ms/);
    assert.deepStrictEqual(seen.released, [true]);
    assert.strictEqual(session.stats().inFlight, 0, 'the keys are free for the next tick');
});

test('a statement fails while passes run on the connection: each still gives its own lock back there, and it is closed after the last', async () => {
    // Retired is not dead: a stalled server answers later. A lock left on the retired connection
    // would keep that job from running on any replica until the longest pass on it was done.
    const { pool, seen } = fakePool({ onQuery: (_sql, params) => (params && params[0] === 99 ? Promise.reject(new Error('out of shared memory')) : undefined) });
    const session = createLockSession({ pool });
    const long = gate();
    const short = gate();
    const first = session.withSessionLock(1, () => long.closed);
    const second = session.withSessionLock(2, () => short.closed);
    await new Promise((r) => setImmediate(r));
    await assert.rejects(session.withSessionLock(99, async () => 'never'), /out of shared memory/);

    short.open();
    await second;
    assert.deepStrictEqual(seen.queries, ['lock:1', 'lock:2', 'lock:99', 'unlock:2'], 'the finished pass gave its lock back on the retired connection');
    assert.deepStrictEqual(seen.released, [], 'still carrying the first lock');
    // Its next tick goes on a fresh connection.
    assert.deepStrictEqual(await session.withSessionLock(2, async () => 'next tick'), { ran: true, value: 'next tick' });
    assert.strictEqual(seen.connects, 2);

    long.open();
    await first;
    assert.deepStrictEqual(seen.queries.slice(-1), ['unlock:1']);
    assert.deepStrictEqual(seen.released, [undefined, true], 'the fresh one went back to the pool, the retired one was closed');
});

test('a lock granted after its caller gave up is given back', async () => {
    /** @type {() => void} */
    let answer = () => {};
    const { pool, seen } = fakePool({
        onQuery: (sql, params) => (params && params[0] === 7 && !sql.includes('unlock')
            ? /** @type {Promise<{ rows: any[] }>} */ (new Promise((resolve) => { answer = () => resolve({ rows: [{ locked: true }] }); }))
            : undefined),
    });
    const session = createLockSession({ pool, statementTimeoutMs: 30 });
    const hold = gate();
    const running = session.withSessionLock(1, () => hold.closed);
    await new Promise((r) => setImmediate(r));
    let ran = false;
    await assert.rejects(session.withSessionLock(7, async () => { ran = true; }), /did not answer within 30 ms/);
    assert.deepStrictEqual(seen.queries, ['lock:1', 'lock:7']);

    // The stalled statement is answered after all: Postgres granted the lock.
    answer();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ran, false, 'no pass runs under a lock nobody waited for');
    assert.deepStrictEqual(seen.queries, ['lock:1', 'lock:7', 'unlock:7'], 'the late grant went back');

    hold.open();
    await running;
    assert.deepStrictEqual(seen.queries.slice(-1), ['unlock:1']);
    assert.deepStrictEqual(seen.released, [true]);
});

test('no connection: the error reaches the caller and the key is free again', async () => {
    let fail = true;
    const { pool, seen } = fakePool();
    const real = pool.connect;
    pool.connect = async () => {
        if (fail) { seen.connects += 1; throw new Error('timeout exceeded when trying to connect'); }
        return real();
    };
    const session = createLockSession({ pool: () => pool });
    await assert.rejects(session.withSessionLock(11, async () => 1), /timeout exceeded/);
    assert.deepStrictEqual(session.stats(), { inFlight: 0, connected: false, users: 0 });
    fail = false;
    assert.deepStrictEqual(await session.withSessionLock(11, async () => 1), { ran: true, value: 1 });
});
