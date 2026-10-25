// @typecheck strict
/**
 * The lease/claim/heartbeat half of a Postgres job queue, shared by
 * gmeetImportStore and teamsImportStore (same table shape: `id UUID`,
 * `status`, `next_attempt_at`, `attempts`, `error_code`, `last_error`,
 * `updated_at`).
 *
 *   claimDueJobs(limit)  FOR UPDATE SKIP LOCKED over the due rows in
 *                        'pending' / 'awaiting_artifacts', then a 10-minute
 *                        lease on next_attempt_at, in one transaction
 *                        (db.withTransaction) so concurrent workers never
 *                        claim the same row and a crashed worker's rows come
 *                        back after the lease.
 *   heartbeatJob(id, m)  extend a running job's lease by m minutes.
 *   failJob(id, opts)    count an attempt; `terminal` freezes the row with the
 *                        error code as its status, otherwise it is retried
 *                        after `backoffMs` in `status` (or the current status).
 *
 * `table` and `orderBy` are SQL fragments from the calling store, never user
 * input.
 */

'use strict';

/**
 * @param {{
 *   table: string,
 *   orderBy: string,
 *   mapRow: (row: any) => any,
 *   initDB: () => Promise<void>,
 *   db?: { withTransaction: (fn: (client: any) => Promise<any>) => Promise<any>, run: (sql: string, params?: any[]) => Promise<{ rowCount: number, rows: any[] }> },
 * }} opts  `db` is a test seam; the stores use ../../db.
 */
function makeLeasedJobQueue({ table, orderBy, mapRow, initDB, db = require('../../db') }) {
    /** @param {number} [limit] */
    async function claimDueJobs(limit = 2) {
        await initDB();
        return db.withTransaction(async (client) => {
            const sel = await client.query(
                `SELECT id FROM ${table}
                 WHERE status IN ('pending', 'awaiting_artifacts')
                   AND next_attempt_at <= NOW()
                 ORDER BY ${orderBy}
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED`,
                [limit],
            );
            if (sel.rows.length === 0) return [];
            const upd = await client.query(
                `UPDATE ${table}
                    SET next_attempt_at = NOW() + INTERVAL '10 minutes',
                        updated_at = NOW()
                  WHERE id = ANY($1::uuid[])
                  RETURNING *`,
                [sel.rows.map((/** @type {{ id: string }} */ r) => r.id)],
            );
            return upd.rows.map(mapRow);
        });
    }

    /**
     * @param {string} id
     * @param {number} [minutes]
     * @returns {Promise<boolean>} false when the job no longer exists.
     */
    async function heartbeatJob(id, minutes = 10) {
        await initDB();
        const { rowCount } = await db.run(
            `UPDATE ${table}
                SET next_attempt_at = NOW() + ($2::int * INTERVAL '1 minute'),
                    updated_at = NOW()
              WHERE id = $1`,
            [id, minutes],
        );
        return rowCount > 0;
    }

    /**
     * @param {string} id
     * @param {{ errorCode?: string|null, lastError?: string|null, terminal?: boolean, backoffMs?: number, status?: string|null }} [opts]
     */
    async function failJob(id, { errorCode = null, lastError = null, terminal = false, backoffMs = 0, status = null } = {}) {
        await initDB();
        if (terminal) {
            const { rowCount } = await db.run(
                `UPDATE ${table}
                    SET attempts = attempts + 1,
                        status = $2,
                        error_code = $3,
                        last_error = $4,
                        updated_at = NOW()
                  WHERE id = $1`,
                [id, errorCode || 'failed', errorCode, lastError],
            );
            return rowCount > 0;
        }
        const { rowCount } = await db.run(
            `UPDATE ${table}
                SET attempts = attempts + 1,
                    status = COALESCE($2, status),
                    error_code = $3,
                    last_error = $4,
                    next_attempt_at = NOW() + ($5 * INTERVAL '1 millisecond'),
                    updated_at = NOW()
              WHERE id = $1`,
            [id, status, errorCode, lastError, backoffMs],
        );
        return rowCount > 0;
    }

    return { claimDueJobs, heartbeatJob, failJob };
}

module.exports = { makeLeasedJobQueue };
