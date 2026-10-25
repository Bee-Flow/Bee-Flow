// @typecheck strict
// Several config reads/writes as ONE transaction (see withConfigGroup). Split out
// of configStore.js; the store injects its own init, transaction and cache hooks.

'use strict';

/**
 * @param {{ initDB: () => Promise<any>, withTransaction: (fn: (client: any) => Promise<any>) => Promise<any>, onWritten: (key: string) => void }} deps
 */
function createWithConfigGroup({ initDB, withTransaction, onWritten }) {
    /**
     * Run several config reads/writes as ONE transaction serialised on `lockKey`
     * (the same advisory lock mutateConfig takes for that key). `work(io)` gets
     * { get(key), set(key, value), keysLike(pattern) }; it may be retried-free but
     * must have no side effects outside `io`. Every written key's cache is busted
     * and broadcast after COMMIT. Used where a content row and rows derived from it
     * (locale overrides) must change together.
     * @template T
     * @param {string} lockKey
     * @param {(io: { get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>, keysLike: (pattern: string) => Promise<string[]> }) => Promise<T>} work
     * @returns {Promise<T>}
     */
    return async function withConfigGroup(lockKey, work) {
        await initDB();
        /** @type {string[]} */
        const written = [];
        const result = await withTransaction(async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
            return work({
                /**
                 * @param {string} key
                 */
                async get(key) {
                    const row = await client.query('SELECT value FROM config WHERE key = $1', [key]);
                    if (!row.rows.length) return null;
                    try { return JSON.parse(row.rows[0].value); } catch (_) { return row.rows[0].value; }
                },
                /**
                 * @param {string} key
                 */
                async set(key, value) {
                    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                    await client.query(
                        `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
                         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                        [key, stringValue]
                    );
                    written.push(key);
                },
                /**
                 * @param {string} pattern
                 */
                async keysLike(pattern) {
                    const rows = await client.query('SELECT key FROM config WHERE key LIKE $1', [pattern]);
                    return rows.rows.map((/** @type {{ key: string }} */ r) => r.key);
                },
            });
        });
        for (const key of written) onWritten(key);
        return result;
    }
}

module.exports = { createWithConfigGroup };
