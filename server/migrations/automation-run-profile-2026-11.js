// @typecheck strict
/**
 * Migration: the run profile and the test journey (automation build-and-test
 * round, 2026-11). One migration for every column of that round, so the items
 * that build on it never race each other over DDL.
 *
 *   automation_runs.run_profile   JSONB: the run's profile
 *       (core/automationModel/runProfile.mts): kind, copy, effects, pauses,
 *       approver seat, notifications, answers sink, stop bound, marker. NULL on
 *       every older row; profileOfRun derives those from mode / is_test /
 *       trigger_kind exactly as they ran.
 *   automation_approvals.is_test           a test or dry run's approval (the
 *       sandbox seat); reminder, escalation and event sweeps skip it.
 *   automation_approvals.sandbox_user_id   the tester who holds that seat.
 *   automation_approvals.configured_routing JSONB: the stages / panel the step
 *       would have gone to in production, kept for the "in production this goes
 *       to ..." preview. Never used to route.
 *   automation_form_pages.is_test          a test-link page row: serves the
 *       working copy to the page's test audience; production listers skip it.
 *   automation_form_pages.issued_by_user_id  who made the test link.
 *   automation_form_pages.expires_at       when the test link stops working
 *       (NULL = never).
 *   automation_form_sessions.is_test       a session opened through a test link.
 *
 * Additive, nullable or defaulted, no backfill. Idempotent (IF NOT EXISTS):
 * every boot replays the automationStore ladder. `exec` is injectable for the
 * in-process Postgres test.
 */

/** @param {{ exec?: (sql: string) => Promise<unknown> }} [opts] */
async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS run_profile JSONB NULL;
        ALTER TABLE automation_approvals ADD COLUMN IF NOT EXISTS is_test BOOLEAN NULL;
        ALTER TABLE automation_approvals ADD COLUMN IF NOT EXISTS sandbox_user_id TEXT NULL;
        ALTER TABLE automation_approvals ADD COLUMN IF NOT EXISTS configured_routing JSONB NULL;
        ALTER TABLE automation_form_pages ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE automation_form_pages ADD COLUMN IF NOT EXISTS issued_by_user_id TEXT NULL;
        ALTER TABLE automation_form_pages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;
        ALTER TABLE automation_form_sessions ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
    `);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
