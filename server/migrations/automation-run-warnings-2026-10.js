/**
 * Migration: Add warnings_json to automation_runs (2026-10).
 *
 * A run has always COLLECTED warnings: a `{{ }}` placeholder that resolved to
 * nothing, a ref or an expr that gave no value, a pick that held twelve values
 * for a field that takes one, a branch with no edge. They went onto
 * runState._templateWarnings and were never written anywhere, so the person
 * reading the run saw a green run and an empty field, and nothing that said
 * why. This column is where the runner now writes them when the run ends
 * (execution.js), and rowToRun hands them to the run view.
 *
 * What is in it: short sentences naming an input, a label the author gave a
 * value, a path or an expression. Never a value from the run (bind.js
 * bindingWarningText builds them that way), so the column holds no personal
 * data and needs none of the token-vault care.
 *
 * Nullable, no backfill: an older run simply has no warnings recorded.
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 *
 * `exec` is injectable so the test runs it without the database.
 */

async function up({ exec } = require('../db')) {
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS warnings_json JSONB`);
}

module.exports = { up };
