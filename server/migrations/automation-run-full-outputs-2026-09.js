/**
 * Migration: automation_run_full_outputs (2026-09, BFSF-435).
 *
 * automation_run_steps.output_json holds at most 256 KB per payload; above
 * that payloadTruncation replaces the whole value with a sentinel. The run
 * history can live with that. A run that PAUSES cannot: when it resumes after
 * a form page or an approval, runState is rebuilt from these rows, and a
 * sentinel is not the step's output — the step came back as a hole, every
 * downstream binding resolved to nothing, and the run stayed green.
 *
 * This table keeps the full (already redacted) output of such a step, gzipped,
 * keyed exactly like its run-step row. The sentinel in output_json carries a
 * `fullOutputRef` naming it; the resume swaps it back, and the run history's
 * Output panel can fetch it on demand (BFSF-402).
 *
 * The FK is to automation_runs, not to the step row: the copy is written just
 * before the step row it belongs to, so the row can name it only once it is
 * known to exist. ON DELETE CASCADE lets run retention and automation deletion
 * take the copies with the run, like the step rows.
 *
 * Idempotent — CREATE TABLE IF NOT EXISTS; the primary key doubles as the
 * run_id index the cascade needs.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_run_full_outputs (
            run_id          TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
            step_id         TEXT NOT NULL,
            attempts        INTEGER NOT NULL DEFAULT 1,
            output_gz       BYTEA NOT NULL,
            original_bytes  BIGINT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (run_id, step_id, attempts)
        )
    `);
}

module.exports = { up };
