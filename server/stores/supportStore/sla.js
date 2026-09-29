// @typecheck
/**
 * SLA — the per-org × priority policies (support_sla_policies), the due-date
 * timers stamped on a thread, and the enforcement sweeps that flag first-response
 * and resolution breaches, plus the "nobody has answered this yet" query.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');

async function findSlaAtRiskThreads({ olderThanMinutes = 60 } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_threads
         WHERE status = 'awaiting_agent'
           AND first_response_at IS NULL
           AND created_at < now() - ($1::int * interval '1 minute')
         ORDER BY created_at ASC
         LIMIT 50`,
        [olderThanMinutes]
    );
    return rows;
}

// ── SLA policies ─────────────────────────────────────────────────────────────

/**
 * Resolve the SLA policy for an org+priority, falling back to the global
 * (NULL-org) policy when no org-specific one exists.
 */
async function getSlaPolicy(organizationId, priority) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_sla_policies
          WHERE priority = $2
            AND (organization_id = $1 OR organization_id IS NULL)
          ORDER BY (organization_id IS NULL) ASC
          LIMIT 1`,
        [organizationId, priority]
    );
    return rows[0] || null;
}

async function listSlaPolicies(organizationId = null) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_sla_policies
          WHERE organization_id IS NULL OR organization_id = $1
          ORDER BY (organization_id IS NULL) DESC,
                   array_position(ARRAY['urgent','high','normal','low'], priority)`,
        [organizationId]
    );
    return rows;
}

async function upsertSlaPolicy({ organizationId = null, priority, firstResponseMinutes, resolutionMinutes, enabled = true }) {
    await initDB();
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw new Error('invalid priority');
    // Partial unique indices differ by NULL-ness, so branch the conflict target.
    if (organizationId == null) {
        const { rows } = await pool.query(
            `INSERT INTO support_sla_policies
                (organization_id, priority, first_response_minutes, resolution_minutes, enabled)
             VALUES (NULL, $1, $2, $3, $4)
             ON CONFLICT (priority) WHERE organization_id IS NULL
             DO UPDATE SET first_response_minutes = EXCLUDED.first_response_minutes,
                           resolution_minutes = EXCLUDED.resolution_minutes,
                           enabled = EXCLUDED.enabled, updated_at = now()
             RETURNING *`,
            [priority, firstResponseMinutes, resolutionMinutes, enabled]
        );
        return rows[0];
    }
    const { rows } = await pool.query(
        `INSERT INTO support_sla_policies
            (organization_id, priority, first_response_minutes, resolution_minutes, enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, priority) WHERE organization_id IS NOT NULL
         DO UPDATE SET first_response_minutes = EXCLUDED.first_response_minutes,
                       resolution_minutes = EXCLUDED.resolution_minutes,
                       enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING *`,
        [organizationId, priority, firstResponseMinutes, resolutionMinutes, enabled]
    );
    return rows[0];
}

// ── SLA timers ───────────────────────────────────────────────────────────────

async function setThreadSla(threadId, { firstDueAt = null, resolutionDueAt = null }) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET sla_first_response_due_at = $2,
                sla_resolution_due_at = $3,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [threadId, firstDueAt, resolutionDueAt]
    );
    return rows[0] || null;
}

// ── SLA enforcement queries ─────────────────────────────────────────────────

/**
 * Atomically flag first-response SLA breaches. Returns the rows just flagged
 * so the caller can notify. Idempotent: the WHERE clause excludes already-flagged.
 * `inbox_id` tells the caller whose inbox it is: only the company inbox (NULL)
 * may be posted to the team chat channel.
 */
async function flagFirstResponseBreaches() {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET sla_first_response_breached_at = now(), updated_at = now()
          WHERE sla_first_response_breached_at IS NULL
            AND sla_first_response_due_at IS NOT NULL
            AND sla_first_response_due_at < now()
            AND first_response_at IS NULL
            AND status NOT IN ('resolved','closed')
            AND sla_paused = false
          RETURNING id, subject, assignee_user_id, requester_email, organization_id, inbox_id`
    );
    return rows;
}

async function flagResolutionBreaches() {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET sla_resolution_breached_at = now(), updated_at = now()
          WHERE sla_resolution_breached_at IS NULL
            AND sla_resolution_due_at IS NOT NULL
            AND sla_resolution_due_at < now()
            AND status NOT IN ('resolved','closed')
            AND sla_paused = false
          RETURNING id, subject, assignee_user_id, requester_email, organization_id, inbox_id`
    );
    return rows;
}

module.exports = {
    findSlaAtRiskThreads,
    getSlaPolicy,
    listSlaPolicies,
    upsertSlaPolicy,
    setThreadSla,
    flagFirstResponseBreaches,
    flagResolutionBreaches,
};
