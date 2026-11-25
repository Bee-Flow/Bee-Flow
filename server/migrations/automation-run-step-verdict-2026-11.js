// @typecheck strict
/**
 * Migration: automation_run_steps.verdict.
 *
 * An AI step that is asked for it (`reportOutcome`, set by Cowork on the run copy of a plan:
 * core/cowork/plan/planRunCopy.mts) ends with its own verdict on its work: `{ outcome: 'done' | 'nothing_to_do' |
 * 'failed', reason }` (core/automationRunner/aiStepVerdict.mts). It is kept beside the step's output, never in it:
 * the output is the bindable namespace and a downstream step reads it as before. Cowork reads the verdicts after the
 * run (core/cowork/runOutcome.mts) and may only make the run worse by them, never better (decision 0050).
 *
 * NULL is "no verdict asked or given" and what every existing row already is, so there is no backfill.
 *
 * Idempotent (IF NOT EXISTS): every boot replays the automationStore ladder. `exec` is injectable so a test can run
 * the real SQL against an in-process Postgres.
 */

/** @param {{ exec?: (sql: string) => Promise<unknown> }} [opts] */
async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS verdict JSONB NULL;
    `);
}

module.exports = { up };
