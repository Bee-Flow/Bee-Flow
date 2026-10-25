// @typecheck noImplicitAny
/**
 * Migration: runs that use the caller's own connections (runPolicy.connections
 * = 'caller', Refs #201).
 *
 *   automation_runs.connections_mode   'caller' when the run was started by
 *       somebody other than the owner under that policy, NULL otherwise. Fixed
 *       at the start of a run and reused on resume, so changing the setting
 *       mid-flight cannot widen a paused run. The starter is the existing
 *       started_by_user_id. Run-read paths use the pair to show step payloads
 *       to the starter only.
 *   automation_run_steps.identity_user_id   the user an integration step ran
 *       as (a user id, nothing else), NULL for steps that use no connection.
 *   automation_caller_notices   one row per (user, automation) once the person
 *       has seen the "this automation uses your own connections" notice; `items`
 *       is the JSON list of apps and destinations they acknowledged, so the
 *       notice shows again when the automation grows one.
 *
 * Idempotent (IF NOT EXISTS): every boot replays the automationStore ladder.
 * `exec` is injectable for the in-process Postgres test.
 */

/** @param {{ exec?: (sql: string) => Promise<unknown> }} [opts] */
async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS connections_mode TEXT NULL;
        ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS identity_user_id TEXT NULL;
        CREATE TABLE IF NOT EXISTS automation_caller_notices (
            user_id        TEXT NOT NULL,
            automation_id  TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            items          TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (user_id, automation_id)
        );
        ALTER TABLE automation_caller_notices ADD COLUMN IF NOT EXISTS items TEXT NOT NULL DEFAULT '[]';
    `);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
