/**
 * Migration: multi-trigger routines, second slice (2026-09).
 *
 * 1. `automation_runs.root_step_id` — WHICH trigger node a run entered through.
 *    The 2026-07 slice let a routine carry extra webhook/app-event triggers
 *    (`definition.triggers[]`) and seeded the DAG walk from the one that fired,
 *    but that fact lived only in memory. A run that paused on an approval under
 *    a secondary trigger therefore RESUMED from the primary trigger, dispatched
 *    nothing, and drained to "success" having done no work. Persisting the root
 *    is what lets resume.js pick the same entry point again. NULL means "the
 *    primary trigger", exactly like `trigger_step_id` on the other tables.
 *
 * 2. `automation_schedules` — one row per ADDITIONAL schedule trigger. The
 *    primary schedule keeps living in `automations.schedule_cron / schedule_tz /
 *    next_run_at` (no data migration, nothing to backfill); this table only
 *    holds the extra ones, keyed by the trigger node they belong to. The
 *    `automations` row stays the concurrency lock — a due row here is claimed
 *    through it, so a secondary schedule can never run a routine twice at once.
 *
 * Idempotent — ADD COLUMN / CREATE TABLE / CREATE INDEX all IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS root_step_id TEXT`);
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_schedules (
            id                  TEXT PRIMARY KEY,
            automation_id       TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            trigger_step_id     TEXT NOT NULL,
            cron                TEXT NOT NULL,
            tz                  TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
            next_run_at         TIMESTAMPTZ,
            last_run_at         TIMESTAMPTZ,
            last_status         TEXT,
            running_instance_id TEXT,
            claimed_at          TIMESTAMPTZ,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (automation_id, trigger_step_id)
        )
    `);
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_automation_schedules_due
            ON automation_schedules (next_run_at)
            WHERE next_run_at IS NOT NULL
    `);
    console.log('[Migration] automation-multi-trigger-2026-09 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
