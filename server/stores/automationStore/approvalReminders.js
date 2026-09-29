// @typecheck
/**
 * approvalReminders.js — the "send reminder" button's rate limit (handoff 5).
 *
 * A manual reminder is an event in the approval's own append-only log
 * (automation_approval_audit, decision 'reminded', source 'manual'), and the
 * log IS the limiter: a reminder is allowed when the log holds none for this
 * approval inside the window. That keeps the limit across pods and restarts
 * without a column of its own, and leaves the reminder visible in the audit
 * trail of the approval, where the owner already reads what happened to it.
 *
 * The check and the write are one transaction under an advisory lock on the
 * approval, so two clicks racing on two pods cannot both pass the check.
 */

const crypto = require('crypto');
const { initDB, getClient } = require('./core');

const REMIND_WINDOW_MINUTES = 10;

/**
 * Claim the right to send one manual reminder for a PENDING approval.
 *
 * @param {string} approvalId
 * @param {{ byUserId?: string|null, windowMinutes?: number }} [opts]
 * @param {{ getClient?: () => Promise<{ query: Function, release: Function }> }} [deps]  a test's own database
 * @returns {Promise<{ claimed: true, at: string } | { claimed: false, reason: 'rate_limited', lastAt: string, nextAt: string } | { claimed: false, reason: 'not_pending' }>}
 */
async function claimApprovalReminder(approvalId, { byUserId = null, windowMinutes = REMIND_WINDOW_MINUTES } = {}, deps = {}) {
    if (!deps.getClient) await initDB();
    const minutes = Math.max(1, Math.round(Number(windowMinutes) || REMIND_WINDOW_MINUTES));
    const client = await (deps.getClient || getClient)();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`approval-remind:${approvalId}`]);
        const last = await client.query(
            `SELECT MAX(ts) AS ts FROM automation_approval_audit
              WHERE approval_id = $1 AND decision = 'reminded'`,
            [approvalId],
        );
        const lastTs = last.rows[0]?.ts ? new Date(last.rows[0].ts) : null;
        const now = await client.query('SELECT NOW() AS now');
        const nowTs = new Date(now.rows[0].now);
        if (lastTs && nowTs.getTime() - lastTs.getTime() < minutes * 60_000) {
            await client.query('ROLLBACK');
            return {
                claimed: false, reason: 'rate_limited',
                lastAt: lastTs.toISOString(),
                nextAt: new Date(lastTs.getTime() + minutes * 60_000).toISOString(),
            };
        }
        const inserted = await client.query(
            `INSERT INTO automation_approval_audit (id, approval_id, run_id, step_id, decided_by, decision, source)
             SELECT $1, a.id, a.run_id, a.step_id, $3, 'reminded', 'manual'
               FROM automation_approvals a
              WHERE a.id = $2 AND a.status = 'pending'
             RETURNING ts`,
            [crypto.randomUUID(), approvalId, byUserId],
        );
        if (!inserted.rows.length) {
            await client.query('ROLLBACK');
            return { claimed: false, reason: 'not_pending' };
        }
        await client.query('COMMIT');
        return { claimed: true, at: new Date(inserted.rows[0].ts).toISOString() };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* the original error is the one to report */ }
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { claimApprovalReminder, REMIND_WINDOW_MINUTES };
