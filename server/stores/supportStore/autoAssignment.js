// @typecheck
/**
 * Auto-assignment — the per-org round-robin cursor (support_assignment_state)
 * that decides which staff member an escalation lands on, advanced under
 * SELECT … FOR UPDATE so two concurrent escalations can't pick the same agent.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');

// ── Auto-assignment round-robin ──────────────────────────────────────────────

/**
 * Atomically advance the round-robin cursor for an org and return the next
 * assignee from `candidateUserIds` (ordered list). Serialised per-org via
 * SELECT … FOR UPDATE so concurrent escalations don't double-assign.
 */
async function getAndAdvanceRoundRobin(organizationId, candidateUserIds = []) {
    await initDB();
    if (!candidateUserIds.length) return null;
    const key = organizationId || '__global__';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT last_assignee_user_id FROM support_assignment_state
              WHERE organization_id = $1 FOR UPDATE`,
            [key]
        );
        const last = rows[0]?.last_assignee_user_id || null;
        const lastIdx = candidateUserIds.indexOf(last);
        const next = candidateUserIds[(lastIdx + 1) % candidateUserIds.length];
        await client.query(
            `INSERT INTO support_assignment_state (organization_id, last_assignee_user_id, updated_at)
             VALUES ($1, $2, now())
             ON CONFLICT (organization_id)
             DO UPDATE SET last_assignee_user_id = EXCLUDED.last_assignee_user_id, updated_at = now()`,
            [key, next]
        );
        await client.query('COMMIT');
        return next;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { getAndAdvanceRoundRobin };
