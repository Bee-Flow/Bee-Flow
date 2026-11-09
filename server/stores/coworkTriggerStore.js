// @typecheck strict
/**
 * The run ledger of an agent that is started by an event (a new mail), next to coworkStore: claiming one event
 * exactly once and counting what a schedule has started lately.
 *
 * `cowork_runs` carries `trigger_ref` (the provider's message id) with a unique index on (schedule_id,
 * trigger_ref), so a redelivered notification or a poll that overlaps the previous one cannot start a second run
 * for the same mail. The row is opened here, with the same shape coworkStore.markRunning writes, and
 * markCompleted / markError close it like any other run.
 *
 * Factory over a `{ query }`, like the other small stores: the tests hand it PGlite.
 */

'use strict';

const crypto = require('crypto');
const { pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} db
 * @param {{ ready?: () => Promise<unknown> }} [opts]
 */
function makeCoworkTriggerStore(db, { ready = async () => {} } = {}) {
    /**
     * Open the run for one event, or answer null when this (schedule, event) already has one. The schedule is
     * checked against its owner in the same statement.
     * @param {{ scheduleId: string, userId: string, triggerRef: string, triggerKind?: string }} p
     * @returns {Promise<string | null>} the id of the opened run
     */
    async function claimEventRun({ scheduleId, userId, triggerRef, triggerKind = 'mail' }) {
        await ready();
        const res = await db.query(
            `INSERT INTO cowork_runs (id, schedule_id, user_id, status, trigger_kind, trigger_ref)
             SELECT $1, s.id, s.user_id, 'running', $4, $5
               FROM cowork_schedules s WHERE s.id = $2 AND s.user_id = $3
             ON CONFLICT (schedule_id, trigger_ref) WHERE trigger_ref IS NOT NULL DO NOTHING
             RETURNING id`,
            [crypto.randomUUID(), scheduleId, userId, triggerKind, triggerRef],
        );
        const id = res.rows[0]?.id ?? null;
        if (id) await db.query(`UPDATE cowork_schedules SET last_status = 'running' WHERE id = $1`, [scheduleId]);
        return id;
    }

    /**
     * How many runs of this kind this schedule started since `sinceMs` ago.
     * @param {{ scheduleId: string, sinceMs: number, triggerKind?: string }} p
     */
    async function countRecentEventRuns({ scheduleId, sinceMs, triggerKind = 'mail' }) {
        await ready();
        const res = await db.query(
            `SELECT COUNT(*)::int AS n FROM cowork_runs
              WHERE schedule_id = $1 AND trigger_kind = $2 AND started_at > NOW() - ($3::bigint * INTERVAL '1 millisecond')`,
            [scheduleId, triggerKind, Math.max(0, Math.floor(sinceMs))],
        );
        return res.rows[0]?.n || 0;
    }

    return { claimEventRun, countRecentEventRuns };
}

const initDB = makeStoreInit('CoworkTriggerStore', async () => { await require('./ddl/cowork-2026-08').up(); });

module.exports = {
    makeCoworkTriggerStore,
    ...makeCoworkTriggerStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB }),
};
