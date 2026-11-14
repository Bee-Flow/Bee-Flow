// @typecheck strict
/**
 * The rollback marker and the transaction runner of db.withTransaction, in a
 * module of its own so a test fake of db.js can honour `return rollback(v)`
 * without loading the real pool, and so a store that is handed its own
 * `getClient` (an injected engine, a factory over a facade) runs its
 * transaction through the same runner as db.withTransaction.
 */

const { bestEffort } = require('./bestEffort');

/**
 * The part of a pooled client a transaction uses.
 * @typedef {{ query: (sql: string, params?: any[]) => Promise<any>, release: () => void }} TxClient
 */

class TransactionRollback {
    /** @param {unknown} value */
    constructor(value) { this.value = value; }
}

/**
 * Early exit from a withTransaction callback: `return rollback(value)` makes
 * the transaction ROLLBACK (not COMMIT), release the client and resolve to
 * `value`. For "nothing to do / not found" paths that must undo what the
 * callback already did (a FOR UPDATE lock, a partial write) without throwing.
 * @template T
 * @param {T} [value]
 * @returns {any} a marker, only meaningful as the callback's return value
 */
function rollback(value) {
    return new TransactionRollback(value);
}

/**
 * COMMIT a finished withTransaction callback, or ROLLBACK when it returned
 * `rollback(value)`; resolves to the callback's value either way.
 * @param {Pick<TxClient, 'query'>} client
 * @param {any} result
 */
async function settleTransaction(client, result) {
    if (result instanceof TransactionRollback) {
        await client.query('ROLLBACK');
        return result.value;
    }
    await client.query('COMMIT');
    return result;
}

/**
 * BEGIN → fn → COMMIT on a client just checked out, ROLLBACK on any throw (or
 * on `return rollback(v)`), and release in `finally`: the transaction ends
 * once, the client goes back once, and nothing is sent on it afterwards.
 * `begin` is the opening statement (`'BEGIN READ ONLY'` for a read).
 * @template T
 * @param {TxClient} client
 * @param {(client: TxClient) => Promise<T>} fn
 * @param {{ begin?: string }} [opts]
 * @returns {Promise<T>}
 */
async function runTransaction(client, fn, { begin = 'BEGIN' } = {}) {
    try {
        await client.query(begin);
        const result = await fn(client);
        return await settleTransaction(client, result);
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (err) { bestEffort('txRollback:runTransaction', err); /* connection may be dead */ }
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { TransactionRollback, rollback, settleTransaction, runTransaction };
