// @typecheck
/**
 * chat_signal_objections — "Don't count my chat turns" (GDPR Art. 21).
 *
 * One row per person who objected; no history, no timestamps. The recorder
 * (core/privacy/chatSignals.js) asks `isObjecting` before it counts a signed-in
 * person's turn, and the person's own self-scoped route reads and writes it.
 *
 * NOTHING ELSE READS THIS TABLE. There is deliberately no list or count
 * function: an objection never appears in an admin view, list, count or
 * evidence (amendment 12). Account erasure deletes the row
 * (stores/user/users.js deleteUser).
 *
 * When in doubt, do not count: a read error reads as "objecting".
 */

'use strict';

const { exec, pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { createTtlCache } = require('../utils/ttlCache');
const log = require('../telemetry/log');

const DDL = `CREATE TABLE IF NOT EXISTS chat_signal_objections (user_id TEXT PRIMARY KEY);`;

const MEMO_TTL_MS = 30_000;
const MEMO_MAX = 5000;

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} db
 * @param {{ ready?: () => Promise<unknown>, now?: () => number }} [opts]
 */
function makeChatSignalObjectionStore(db, { ready = async () => {}, now = Date.now } = {}) {
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };
    const memo = createTtlCache({ ttlMs: MEMO_TTL_MS, max: MEMO_MAX, now });

    /**
     * Has this person objected? Never throws; memoised for 30 s. A read error
     * (or a missing id) reads as true and is not memoised.
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    async function isObjecting(userId) {
        if (!userId || typeof userId !== 'string') return true;
        const hit = memo.get(userId);
        if (hit !== undefined) return hit;
        try {
            const { rows } = await q(`SELECT 1 AS one FROM chat_signal_objections WHERE user_id = $1`, [userId]);
            const objecting = rows.length > 0;
            memo.set(userId, objecting);
            return objecting;
        } catch (e) {
            log.warn('[ChatSignalObjections] read failed; not counting:', e && e.code ? e.code : 'error');
            return true;
        }
    }

    /**
     * Record or withdraw the objection. Throws on a write error, so the
     * person's own route can say it did not save.
     * @param {string} userId
     * @param {boolean} objecting
     */
    async function setObjecting(userId, objecting) {
        if (!userId || typeof userId !== 'string') throw new Error('chat_signal_objection_no_user');
        memo.del(userId);
        if (objecting) {
            await q(`INSERT INTO chat_signal_objections (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
        } else {
            await q(`DELETE FROM chat_signal_objections WHERE user_id = $1`, [userId]);
        }
        memo.del(userId);
        return !!objecting;
    }

    return { isObjecting, setObjecting };
}

const initDB = makeStoreInit('ChatSignalObjectionStore', async () => {
    await exec(DDL);
    log.info('[ChatSignalObjectionStore] PostgreSQL initialized');
});

const defaultStore = makeChatSignalObjectionStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    makeChatSignalObjectionStore,
    ...defaultStore,
};
