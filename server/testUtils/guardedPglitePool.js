// @typecheck strict
/**
 * The real db.js pool on a fresh PGlite that can refuse a write, for a test of what a
 * failed database write leaves behind (the subscription lifecycle, the Stripe webhook).
 *
 *   const { pg, close, failWrites } = guardedPglitePool();
 *   failWrites(STATUS_WRITE);   // the next subscription status write throws
 *
 * Split out of testUtils/stripeWebhookKit.js (the billing_stripe module's kit), which
 * builds on it, so the core's billing tests do not need that module.
 */

'use strict';

const { usePglitePool } = require('./pglitePool');

/**
 * @typedef {(sql: string | { text?: string }, params?: unknown[]) => Promise<unknown>} Query
 * @typedef {{ query: Query, connect: () => Promise<{ query: Query, release: () => void }> }} PoolSeam
 * @typedef {{ test: (sql: string) => boolean }} Refusal  a RegExp, or anything that decides per statement
 */

/**
 * The real db.js pool on a fresh PGlite (testUtils/pglitePool.js), with one
 * addition: `failWrites(/regex/)` makes it refuse every statement that
 * matches (a RegExp, or any `{ test(sql) }`), the way a database error
 * would, until `failWrites(null)`.
 * `STATUS_WRITE` matches the row write of setOrgSubscription and
 * setConsumerSubscription.
 */
function guardedPglitePool() {
    const { pg, query, close } = usePglitePool();
    const pool = /** @type {PoolSeam} */ (/** @type {unknown} */ (require('../db').pool));
    /** @type {Refusal | null} */
    let refused = null;
    /** @type {Query} */
    const guarded = async (sql, params) => {
        const text = typeof sql === 'string' ? sql : String(sql?.text || '');
        if (refused && refused.test(text)) throw new Error('simulated database failure');
        return query(sql, params);
    };
    pool.query = guarded;
    pool.connect = async () => ({ query: guarded, release() {} });
    return { pg, close, failWrites: (/** @type {Refusal | null} */ re) => { refused = re; } };
}

const STATUS_WRITE = /UPDATE "?(organization|consumer)_subscriptions"? SET "/;

module.exports = { guardedPglitePool, STATUS_WRITE };
