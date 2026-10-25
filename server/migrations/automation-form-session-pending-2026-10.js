// @typecheck noImplicitAny
/**
 * Migration: the accepted-but-not-yet-started form work, on the visitor's
 * session row (2026-10).
 *
 * POST /form/:token answers 202 the moment a submission is accepted and runs
 * the automation in the background, one at a time per automation. That queue
 * used to live only in the process's memory, so a deploy or a crash with
 * submissions still waiting dropped them — submissions the visitor had been
 * told were received. Now the work is written HERE before the 202 goes out and
 * the queue is driven from these columns (automation/formQueue.js):
 *
 *   pending_work         the trigger payload (first page) or the page answers
 *                        plus the paused run/step (a later page). NULL once the
 *                        run that carries it exists. It holds the visitor's
 *                        answers, so it is cleared as soon as it is no longer
 *                        needed, and the row itself is purged with the session
 *                        (8h TTL, run-retention tick).
 *   pending_lease_until  until when the pod that holds this work in its queue
 *                        owns it. That pod renews it while it waits; a lapsed
 *                        lease is work nobody holds any more, and the sweep on
 *                        any pod claims it.
 *   pending_attempts     how often the sweep has picked it up, so work that can
 *                        never run is given up on instead of retried forever.
 *
 * Additive, nullable/defaulted, no backfill, idempotent (IF NOT EXISTS): every
 * boot replays the automationStore ladder. `exec` is injectable so a test can
 * run the real SQL against an in-process Postgres.
 */

/** @param {{ exec?: (sql: string) => Promise<unknown> }} [opts] */
async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        ALTER TABLE automation_form_sessions ADD COLUMN IF NOT EXISTS pending_work JSONB;
        ALTER TABLE automation_form_sessions ADD COLUMN IF NOT EXISTS pending_lease_until TIMESTAMPTZ;
        ALTER TABLE automation_form_sessions ADD COLUMN IF NOT EXISTS pending_attempts INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_automation_form_sessions_pending
            ON automation_form_sessions(pending_lease_until) WHERE pending_work IS NOT NULL;
    `);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
