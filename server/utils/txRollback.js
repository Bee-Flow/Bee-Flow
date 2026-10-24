// @typecheck
/**
 * The rollback marker of db.withTransaction, in a module of its own so a test
 * fake of db.js can honour `return rollback(v)` without loading the real pool.
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
 * @param {import('pg').PoolClient} client
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

module.exports = { TransactionRollback, rollback, settleTransaction };
