// @typecheck
/**
 * schedules.js — automationStore aggregate: ADDITIONAL schedule triggers.
 *
 * One row per `definition.triggers[]` entry of kind 'schedule'
 * (automation-multi-trigger-2026-09). The PRIMARY schedule is not here — it
 * keeps living on the automations row (`schedule_cron` / `next_run_at`) and is
 * claimed by claimDueAutomations. This table only holds the extra ones, keyed
 * by the trigger node they belong to.
 *
 * The automations row stays the ONE concurrency lock: a due schedule row is
 * claimed by flipping its automation to `last_status='running'` under the same
 * FOR UPDATE SKIP LOCKED discipline as claimDueAutomations, so a secondary
 * schedule can never start an automation that is already running — it simply waits
 * for the next tick, like a primary schedule does today. The columns
 * `running_instance_id` / `claimed_at` on the schedule row are observability,
 * not the lock.
 */

const crypto = require('crypto');
const { initDB, run, getAll, getClient } = require('./core');
const { rowToAutomation } = require('./rowMappers');

function rowToSchedule(r) {
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        triggerStepId: r.trigger_step_id,
        cron: r.cron,
        tz: r.tz,
        nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
        lastStatus: r.last_status ?? null,
        runningInstanceId: r.running_instance_id ?? null,
        claimedAt: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
    };
}

/**
 * Create or update the row for (automationId, triggerStepId).
 *
 * `next_run_at` is the A12 discipline in table form: a save that does not
 * change the cron/tz must NOT move the next slot (nudging a node on the canvas
 * used to re-anchor pollers; the same mistake here would re-anchor a schedule
 * to "now + one period" on every save). Pass `rearm: true` — activation does —
 * to recompute it unconditionally, so an automation re-activated after a month
 * does not fire a month's worth of catch-up on the first tick.
 */
async function upsertSchedule({ automationId, triggerStepId, cron, tz, nextRunAt = null, rearm = false }) {
    await initDB();
    const id = 'sch_' + crypto.randomBytes(6).toString('hex');
    const next = nextRunAt ? new Date(nextRunAt).toISOString() : null;
    const rows = await getAll(
        `INSERT INTO automation_schedules (id, automation_id, trigger_step_id, cron, tz, next_run_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (automation_id, trigger_step_id) DO UPDATE
            SET cron = EXCLUDED.cron,
                tz = EXCLUDED.tz,
                updated_at = NOW(),
                next_run_at = CASE
                    WHEN $7::boolean THEN EXCLUDED.next_run_at
                    WHEN automation_schedules.cron = EXCLUDED.cron
                         AND automation_schedules.tz = EXCLUDED.tz
                         AND automation_schedules.next_run_at IS NOT NULL
                        THEN automation_schedules.next_run_at
                    ELSE EXCLUDED.next_run_at
                END
         RETURNING *`,
        [id, automationId, triggerStepId, cron, tz, next, rearm === true],
    );
    return rowToSchedule(rows[0]);
}

/** Drop every schedule row of the automation whose trigger is no longer declared. */
async function deleteSchedulesExcept(automationId, keepTriggerStepIds = []) {
    await initDB();
    const keep = Array.isArray(keepTriggerStepIds) ? keepTriggerStepIds.filter(Boolean) : [];
    await run(
        `DELETE FROM automation_schedules
          WHERE automation_id = $1
            AND NOT (trigger_step_id = ANY($2::text[]))`,
        [automationId, keep],
    );
}

async function listSchedulesForAutomation(automationId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_schedules WHERE automation_id = $1 ORDER BY next_run_at ASC NULLS LAST, trigger_step_id ASC',
        [automationId],
    );
    return rows.map(rowToSchedule);
}

/**
 * Atomically claim due ADDITIONAL schedules for execution.
 *
 * Mirrors claimDueAutomations: FOR UPDATE SKIP LOCKED on the schedule rows,
 * then the automation row is flipped to running — and that flip is what
 * decides whether a row is really claimed. Two due schedules of one automation in
 * the same batch yield ONE run (the earliest); the other stays due and fires
 * on a later tick, exactly like a primary schedule waits for a busy automation.
 *
 * @returns {Promise<Array<{ automation: object, schedule: object }>>}
 */
async function claimDueSchedules(instanceId, limit = 20) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const sel = await client.query(
            `SELECT s.*
               FROM automation_schedules s
               JOIN automations a ON a.id = s.automation_id
              WHERE a.is_active = TRUE
                AND a.is_draft = FALSE
                AND s.next_run_at IS NOT NULL
                AND s.next_run_at <= NOW()
                AND (a.last_status IS NULL OR a.last_status != 'running')
              ORDER BY s.next_run_at ASC
              LIMIT $1
              FOR UPDATE OF s SKIP LOCKED`,
            [limit],
        );
        if (sel.rows.length === 0) {
            await client.query('COMMIT');
            return [];
        }
        // One schedule per automation per tick — the earliest.
        const firstByAutomation = new Map();
        for (const r of sel.rows) {
            if (!firstByAutomation.has(r.automation_id)) firstByAutomation.set(r.automation_id, r);
        }
        const automationIds = [...firstByAutomation.keys()];
        const upd = await client.query(
            `UPDATE automations
                SET last_status = 'running',
                    running_instance_id = $1,
                    running_started_at = NOW()
              WHERE id = ANY($2::text[])
                AND (last_status IS NULL OR last_status != 'running')
              RETURNING *`,
            [instanceId, automationIds],
        );
        const claimedAutomations = new Map(upd.rows.map(r => [r.id, r]));
        const claimedScheduleIds = [...firstByAutomation.values()]
            .filter(s => claimedAutomations.has(s.automation_id))
            .map(s => s.id);
        if (claimedScheduleIds.length) {
            await client.query(
                `UPDATE automation_schedules
                    SET running_instance_id = $1, claimed_at = NOW()
                  WHERE id = ANY($2::text[])`,
                [instanceId, claimedScheduleIds],
            );
        }
        await client.query('COMMIT');
        return [...firstByAutomation.values()]
            .filter(s => claimedAutomations.has(s.automation_id))
            .map(s => ({ automation: rowToAutomation(claimedAutomations.get(s.automation_id)), schedule: rowToSchedule(s) }));
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Move a schedule row to its next slot after a run (or a skipped claim).
 * `nextRunAt: null` parks the row: it will not be claimed again until a save
 * or activation re-arms it.
 */
async function advanceSchedule(id, { nextRunAt = null, lastRunAt = null, lastStatus = null } = {}) {
    await initDB();
    await run(
        `UPDATE automation_schedules
            SET next_run_at = $2,
                last_run_at = COALESCE($3, last_run_at),
                last_status = COALESCE($4, last_status),
                running_instance_id = NULL,
                claimed_at = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [id, nextRunAt ? new Date(nextRunAt).toISOString() : null, lastRunAt ? new Date(lastRunAt).toISOString() : null, lastStatus],
    );
}

/** Clear claim markers older than two hours — cosmetic; the automations reaper is what unblocks re-claiming. */
async function reapStaleScheduleClaims() {
    await initDB();
    await run(
        `UPDATE automation_schedules
            SET running_instance_id = NULL, claimed_at = NULL
          WHERE claimed_at IS NOT NULL AND claimed_at < NOW() - INTERVAL '2 hours'`,
    );
}

module.exports = {
    rowToSchedule,
    upsertSchedule,
    deleteSchedulesExcept,
    listSchedulesForAutomation,
    claimDueSchedules,
    advanceSchedule,
    reapStaleScheduleClaims,
};
