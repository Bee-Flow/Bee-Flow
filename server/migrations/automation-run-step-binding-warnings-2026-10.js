/**
 * Migration: automation_run_steps.binding_warnings.
 *
 * A mapping that found nothing used to leave no trace on the step: the input
 * was empty, the run stayed green, and all anyone could say was "it doesn't
 * always work". The runner now writes every miss down while the step runs
 * (automation/bind.js withBindingLog, core/automationRunner/bindingMisses.js):
 * which input, which path, where the walk stopped and why. This column keeps
 * that list on the step's own row, so the Runs tab and the step's output panel
 * can say "To read Contact ▸ E-mail: nothing there" after the fact.
 *
 * Metadata, like tools_withheld: paths, field names and kinds of value, never
 * the data. NULL is "nothing missed" and what every existing row already is,
 * so there is no backfill. JSONB rather than JSON: the value is a list (its
 * order survives either way) and nothing replays it into run state.
 *
 * Idempotent (IF NOT EXISTS): every boot replays the automationStore ladder.
 * `exec` is injectable so a test can run the real SQL against an in-process
 * Postgres.
 */

async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS binding_warnings JSONB NULL;
    `);
}

module.exports = { up };
