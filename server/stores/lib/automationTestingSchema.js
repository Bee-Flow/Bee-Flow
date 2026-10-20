'use strict';
/**
 * Test data of Automations: the schema.
 *
 *   automation_test_fixtures   an input captured from a finished run, for a test case
 *   automation_test_cases      a named case on a code step or custom node
 *   automation_golden_runs     a finished run kept as the reference for replays
 *   automation_form_scenarios  the answers of a finished run, to dry-run a form again
 *
 * Everything hangs off `automations` and `automation_runs` with ON DELETE
 * CASCADE, so deleting an automation, or the retention reaper deleting a run,
 * takes its captured data along. A test case outlives the fixture of an expired
 * run (fixture_id SET NULL): the case stays, its input reads as unavailable.
 *
 * Idempotent and PGlite-safe (no extensions). Exported so the pg test creates
 * exactly what production creates.
 */

const DDL = `
    CREATE TABLE IF NOT EXISTS automation_test_fixtures (
        id          TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        run_id      TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        step_id     TEXT NOT NULL,
        input_json  JSON NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_automation_test_fixtures_run
        ON automation_test_fixtures(run_id);

    CREATE TABLE IF NOT EXISTS automation_test_cases (
        id          TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        step_id     TEXT NOT NULL,
        name        TEXT NOT NULL,
        input_kind  TEXT NOT NULL CHECK (input_kind IN ('typed', 'run')),
        typed_input_json JSON NULL,
        fixture_id  TEXT NULL REFERENCES automation_test_fixtures(id) ON DELETE SET NULL,
        expect      TEXT NOT NULL DEFAULT 'success' CHECK (expect IN ('success', 'error')),
        assertions_json JSON NOT NULL DEFAULT '[]',
        last_status TEXT NULL,
        last_run_at TIMESTAMPTZ NULL,
        created_by  TEXT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_automation_test_cases_step
        ON automation_test_cases(automation_id, step_id);

    CREATE TABLE IF NOT EXISTS automation_golden_runs (
        id          TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        run_id      TEXT NOT NULL UNIQUE REFERENCES automation_runs(id) ON DELETE CASCADE,
        label       TEXT NULL,
        ignore_paths JSON NOT NULL DEFAULT '[]',
        created_by  TEXT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_replay_json JSON NULL,
        last_replay_run_id TEXT NULL REFERENCES automation_runs(id) ON DELETE SET NULL,
        last_replay_at TIMESTAMPTZ NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_golden_runs_automation
        ON automation_golden_runs(automation_id);

    CREATE TABLE IF NOT EXISTS automation_form_scenarios (
        id          TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        source_run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        answers_json JSON NOT NULL,
        created_by  TEXT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (automation_id, name)
    );
`;

module.exports = { DDL };
