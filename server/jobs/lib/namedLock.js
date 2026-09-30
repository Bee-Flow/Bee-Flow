// @typecheck
/**
 * One pass of a periodic job under a session advisory lock keyed by NAME
 * (`pg_try_advisory_lock(hashtext(name))`), so the pass runs on one replica
 * at a time and the key can never collide with the numbered job locks.
 *
 *   const out = await withNamedLock(pool, 'beeflow:job:x', async (client) => work());
 *   // out: { ran: true, value } | { ran: false } when another replica holds it
 *
 * The lock is released and the client returned whatever `fn` does; an error
 * from `fn` (or from connecting) is re-thrown for the job to log.
 */

'use strict';

/**
 * @template T
 * @param {{ connect: () => Promise<{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>, release: () => void }> }} pool
 * @param {string} name
 * @param {(client: any) => Promise<T>} fn
 * @returns {Promise<{ ran: true, value: T } | { ran: false }>}
 */
async function withNamedLock(pool, name, fn) {
    const client = await pool.connect();
    let acquired = false;
    try {
        const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [name]);
        acquired = !!(lock.rows[0] && lock.rows[0].locked);
        if (!acquired) return { ran: false };
        return { ran: true, value: await fn(client) };
    } finally {
        try { if (acquired) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); } catch (_) { /* best-effort */ }
        client.release();
    }
}

module.exports = { withNamedLock };
