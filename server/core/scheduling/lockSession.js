// @typecheck strict
/**
 * The session advisory locks of the periodic jobs, on ONE pooled connection.
 *
 * A pass that must run on one replica at a time takes a session advisory lock
 * (`pg_try_advisory_lock`) and holds it until the pass is done. A session lock
 * lives on a connection, so every pass used to borrow a connection of its own
 * from the request pool for as long as it ran: minutes, when the pass waits on
 * other hosts. Here all of them share one. It is taken from the pool when the
 * first lock is asked for, carries every lock held at the same time, and goes
 * back when the last one is released, so nothing stays checked out while no
 * pass runs.
 *
 *   const out = await withSessionLock(0xBEEF105, async () => work());
 *   // out: { ran: true, value } | { ran: false } when someone else holds it
 *
 * A number is the key itself (`pg_try_advisory_lock($1)`), a string is hashed
 * (`hashtext($1)`), as in ./namedLock.js. An error from `run`, from connecting
 * or from the lock statement is re-thrown for the job to log; the lock is
 * released whatever happens.
 *
 * What follows from sharing a session:
 *   - Session locks are re-entrant WITHIN a session: a second
 *     pg_try_advisory_lock of a held key succeeds. Two passes of one job in
 *     this process would both "have" the lock. The keys in flight are kept
 *     here and the second one is refused before Postgres is asked.
 *   - When the connection dies, Postgres frees every lock on it at once (as it
 *     did for the single lock of a borrowed connection). Passes that already
 *     run finish; the next lock takes a fresh connection.
 *   - A connection a statement failed on, or did not answer on within 15
 *     seconds, is retired: no new lock goes on it, and it is closed, not
 *     returned, when the last pass on it is done. It may well be alive (a
 *     stalled server answers later), so until then the passes on it keep
 *     their lock, each one still releases its own when it finishes, and a
 *     lock that is granted after its caller gave up is given back. Without
 *     that a finished pass could not run on any replica until the longest
 *     pass on the retired connection was over.
 *   - Only try-locks. A blocking pg_advisory_lock would hold up everybody
 *     else's lock and unlock statements, which run one at a time.
 *
 * Proven against two real connections in ./lockSession.pg.test.js (PGlite is
 * one session and cannot show mutual exclusion).
 */

'use strict';

const { bestEffort } = require('../../utils/bestEffort');

/**
 * @typedef {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>, release: (err?: Error | boolean) => void,
 *   on?: (event: 'error', fn: (err: Error) => void) => unknown, removeListener?: (event: 'error', fn: (err: Error) => void) => unknown }} LockClient
 * @typedef {{ connect: () => Promise<LockClient> }} LockPool
 * @typedef {{ client: LockClient | null, ready: Promise<void>, users: number, broken: boolean, dead: boolean, tail: Promise<unknown>, onError: (err: Error) => void }} Shared
 */

/** @param {number | string} key */
const lockSql = (key) => (typeof key === 'number'
    ? { lock: 'SELECT pg_try_advisory_lock($1) AS locked', unlock: 'SELECT pg_advisory_unlock($1)' }
    : { lock: 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', unlock: 'SELECT pg_advisory_unlock(hashtext($1))' });

/** A lock or unlock statement answers at once or not at all. */
const STATEMENT_TIMEOUT_MS = 15_000;

/** @returns {Shared} a connection record nobody uses yet */
const newShared = () => ({ client: null, ready: Promise.resolve(), users: 0, broken: false, dead: false, tail: Promise.resolve(), onError: () => {} });

/**
 * Hand one statement to the shared connection, after the ones before it, and
 * wait `timeoutMs` for its answer. `sent` is the statement itself: a stalled
 * server can still answer it after `answer` gave up.
 * @param {Shared} shared
 * @param {string} sql
 * @param {(number | string)[]} params
 * @param {number} timeoutMs
 * @returns {{ sent: Promise<{ rows: any[] }>, answer: Promise<{ rows: any[] }>, gaveUp: () => boolean }}
 */
function send(shared, sql, params, timeoutMs) {
    const client = /** @type {LockClient} */ (shared.client);
    const sent = shared.tail.then(() => client.query(sql, params));
    // The next statement waits until this one is over; its outcome goes to its own caller.
    shared.tail = Promise.allSettled([sent]);
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    let gaveUp = false;
    /** @type {Promise<never>} */
    const late = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            gaveUp = true;
            reject(new Error(`advisory lock statement did not answer within ${timeoutMs} ms`));
        }, timeoutMs);
    });
    return { sent, answer: Promise.race([sent, late]).finally(() => clearTimeout(timer)), gaveUp: () => gaveUp };
}

/**
 * @param {{ pool: LockPool | (() => LockPool), statementTimeoutMs?: number }} opts the pool, or a function that
 *   returns it (read on every lease)
 */
function createLockSession({ pool, statementTimeoutMs = STATEMENT_TIMEOUT_MS }) {
    /** Keys this process holds or is taking: `number:<n>` / `string:<name>`. */
    const inFlight = new Set();
    /** @type {Shared | null} the connection new locks go on */
    let current = null;

    /**
     * No new lock goes on this connection; it is closed when its last pass is done.
     * @param {Shared} shared
     */
    function retire(shared) {
        shared.broken = true;
        if (current === shared) current = null;
    }

    /** @returns {Promise<Shared>} the shared connection, one user more */
    async function lease() {
        if (!current) {
            const shared = newShared();
            // The client itself reports the connection lost: Postgres has freed its locks.
            shared.onError = () => { shared.dead = true; retire(shared); };
            shared.ready = (typeof pool === 'function' ? pool() : pool).connect().then((client) => {
                shared.client = client;
                // A checked-out client that loses its connection emits 'error'; unheard, that ends the process.
                if (typeof client.on === 'function') client.on('error', shared.onError);
            });
            current = shared;
        }
        const shared = current;
        shared.users += 1;
        try {
            await shared.ready;
        } catch (e) {
            retire(shared);
            unlease(shared);
            throw e;
        }
        return shared;
    }

    /** @param {Shared} shared */
    function unlease(shared) {
        shared.users -= 1;
        if (shared.users > 0) return;
        if (current === shared) current = null;
        const client = shared.client;
        if (!client) return;
        if (typeof client.removeListener === 'function') client.removeListener('error', shared.onError);
        // `true` makes the pool close the connection instead of reusing it.
        client.release(shared.broken ? true : undefined);
    }

    /**
     * One statement at a time on the shared connection. A failure retires the
     * connection, and so does a statement that does not answer in time: every
     * pass waits on this one queue, and a lock statement has nothing to wait for.
     * A statement its caller gave up on can still be answered later (the server
     * or the network stalled); `answeredLate` is then called with that answer.
     * @param {Shared} shared
     * @param {string} sql
     * @param {(number | string)[]} params
     * @param {(res: { rows: any[] }) => unknown} [answeredLate]
     * @returns {Promise<{ rows: any[] }>}
     */
    function query(shared, sql, params, answeredLate) {
        const { sent, answer, gaveUp } = send(shared, sql, params, statementTimeoutMs);
        return answer.catch((/** @type {unknown} */ e) => {
            retire(shared);
            if (gaveUp() && answeredLate) {
                // A statement that fails after all needs nothing: its caller already has the time-out.
                sent.then(answeredLate, () => undefined).catch((/** @type {unknown} */ err) => bestEffort('core/scheduling/lockSession:answeredLate', err));
            }
            throw e;
        });
    }

    /**
     * @template T
     * @param {number | string} key
     * @param {() => Promise<T>} run
     * @returns {Promise<{ ran: true, value: T } | { ran: false }>}
     */
    async function withSessionLock(key, run) {
        const id = `${typeof key}:${key}`;
        if (inFlight.has(id)) return { ran: false };
        inFlight.add(id);
        const sql = lockSql(key);
        /** @type {Shared | null} */
        let shared = null;
        let acquired = false;
        try {
            const leased = await lease();
            shared = leased;
            const res = await query(leased, sql.lock, [key], (answer) => {
                // Granted after this caller gave up: no pass runs under it, so it goes back at once.
                // Left on the retired connection it would keep the job from running on any replica.
                if (!answer.rows[0]?.locked) return undefined;
                return query(leased, sql.unlock, [key]);
            });
            acquired = !!res.rows[0]?.locked;
            if (!acquired) return { ran: false };
            return { ran: true, value: await run() };
        } finally {
            if (shared) {
                // On a retired connection as well: it stays open until its last pass is done, and
                // a lock left on it until then would keep this job from running on any replica.
                // Only a dead connection is not asked; Postgres freed its locks when it went.
                if (acquired && !shared.dead) {
                    try { await query(shared, sql.unlock, [key]); } catch (err) { bestEffort('core/scheduling/lockSession:withSessionLock', err); }
                }
                unlease(shared);
            }
            inFlight.delete(id);
        }
    }

    return {
        withSessionLock,
        /** What is going on right now, for tests and diagnostics. */
        stats: () => ({ inFlight: inFlight.size, connected: !!(current && current.client), users: current ? current.users : 0 }),
    };
}

/** The process's one lock session, on db.js's pool (read per lease, so a test double of db.js is what it gets). */
const session = createLockSession({ pool: () => require('../../db').pool });

module.exports = { createLockSession, withSessionLock: session.withSessionLock, lockSessionStats: session.stats };
