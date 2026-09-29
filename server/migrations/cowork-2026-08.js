/**
 * Migration: Cowork — scheduled work with a real execution history.
 *
 * Two tables:
 *   cowork_schedules — one row per thing the user asked Bee Flow to go do,
 *                      either once or on a repeat. Column shape deliberately
 *                      mirrors `ai_tasks` so the shared execution engine in
 *                      aiTaskRunner can drive either one (see coworkStore).
 *   cowork_runs      — one row per execution attempt. This is the part
 *                      `ai_tasks` never had: it only kept last_status /
 *                      last_result, so a failed run was overwritten by the
 *                      next one and there was nothing to click into.
 *
 * The `last_*` columns are kept on the schedule anyway — the overview lists
 * every schedule with its latest outcome, and reading one denormalised column
 * beats a correlated subquery per row.
 *
 * IF NOT EXISTS throughout so re-running is safe.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS cowork_schedules (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            repeat_interval TEXT,
            days_of_week TEXT,
            time_of_day TEXT,
            next_run_at TIMESTAMPTZ NOT NULL,
            last_run_at TIMESTAMPTZ,
            last_result TEXT,
            last_status TEXT DEFAULT 'pending',
            is_active BOOLEAN DEFAULT TRUE,
            model_tier TEXT DEFAULT 'fast',
            tools_enabled TEXT DEFAULT '["agent_search"]',
            max_result_length INTEGER DEFAULT 50000,
            run_count INTEGER DEFAULT 0,
            timezone TEXT DEFAULT 'Europe/Amsterdam',
            agent_id TEXT,
            conversation_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_cowork_schedules_user ON cowork_schedules(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cowork_schedules_due ON cowork_schedules(next_run_at, is_active);
        CREATE INDEX IF NOT EXISTS idx_cowork_schedules_agent ON cowork_schedules(agent_id);

        CREATE TABLE IF NOT EXISTS cowork_runs (
            id TEXT PRIMARY KEY,
            schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            trigger_kind TEXT NOT NULL DEFAULT 'schedule',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ,
            duration_ms INTEGER,
            result TEXT,
            error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_cowork_runs_schedule ON cowork_runs(schedule_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cowork_runs_user ON cowork_runs(user_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cowork_runs_open ON cowork_runs(schedule_id) WHERE finished_at IS NULL;

        -- Which apps THIS item may use, as a JSON array of app ids.
        -- NULL means "whatever the user has enabled workspace-wide", which is
        -- how every row behaved before this column existed — so adding it
        -- changes nothing until something writes to it.
        --
        -- Deliberately not the older tools_enabled column: that one defaults to
        -- '["agent_search"]' and holds tool names, so reusing it would read as
        -- "every existing schedule may only search the web".
        ALTER TABLE cowork_schedules ADD COLUMN IF NOT EXISTS enabled_apps TEXT;
    `);
    console.log('[Migration] cowork-2026-08 applied');
}

module.exports = { up };
