// @typecheck strict
/**
 * The schema of Cowork plans (2026-11), as idempotent boot DDL that stores/coworkStore.js applies through runDdl with
 * its other columns.
 *
 * A plan is an automation definition held to Cowork's step list (core/cowork/plan). Two things are kept:
 *
 *   - on the item, which automation its plan is made from (`plan_automation_id`: a person edits that one, in Cowork
 *     or in Studio) and which approved plan a run executes (`plan_id`; NULL means the item has no plan and runs as a
 *     prompt or as its agent, as before);
 *   - per approval one row of `cowork_plans`: the plan AS IT WAS APPROVED, with what it may do and its fingerprint.
 *     A run executes that copy, never the automation of the moment, so a change to the automation takes effect only
 *     when its owner approves it. Earlier approvals stay: they are the item's versions.
 */

const PLAN_DDL = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_plans (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        automation_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (schedule_id, version)
    )`,
    `ALTER TABLE cowork_schedules ADD COLUMN IF NOT EXISTS plan_automation_id TEXT`,
    `ALTER TABLE cowork_schedules ADD COLUMN IF NOT EXISTS plan_id TEXT`,
    // The automation run behind a run of a plan: its step trace lives there (automation_run_steps).
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS automation_run_id TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS plan_id TEXT`,
    // Asked on every end and every resume of any automation run (core/cowork/planRunFollowUp.mts,
    // planHeldDefinition.mts): is it a plan run? Only the rows of plan runs are in the index.
    `CREATE INDEX IF NOT EXISTS idx_cowork_runs_automation_run ON cowork_runs (automation_run_id) WHERE automation_run_id IS NOT NULL`,
    // The sweep of runs that wait for a decision (core/cowork/planRunFollowUp.mts).
    `CREATE INDEX IF NOT EXISTS idx_cowork_runs_waiting ON cowork_runs (started_at, id) WHERE status = 'waiting'`,
]);

module.exports = { PLAN_DDL };
