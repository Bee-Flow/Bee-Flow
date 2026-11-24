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
    // How independent the plan may be (core/cowork/plan/planIndependence.mts): the owner's choice on the item (NULL:
    // not chosen), the level a run started with (kept across its pause), and when its owner decided on a waiting run.
    `ALTER TABLE cowork_schedules ADD COLUMN IF NOT EXISTS independence TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS independence TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ`,
    // What an item may spend on AI in a calendar month, in euros (NULL: no limit); at it, it pauses itself
    // (core/cowork/runBudget.mts).
    `ALTER TABLE cowork_schedules ADD COLUMN IF NOT EXISTS monthly_budget NUMERIC`,
    // Trust per action and recipient (core/cowork/planTrust.mts): how often its owner let a step of the plan through
    // to one recipient since they last stopped it, and whether they let it go on its own. A run keeps the steps it
    // trusted across its pause, like its level.
    `CREATE TABLE IF NOT EXISTS cowork_trust (
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        let_through INTEGER NOT NULL DEFAULT 0,
        trusted BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (schedule_id, step_id, recipient)
    )`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS trusted_steps TEXT`,
    // How a run that the runner called a success really ended (core/cowork/runOutcome.mts): incomplete (a list step
    // found no list), failed by an AI step's own verdict, or an AI's done / nothing to do. Codes, step ids and the plan's
    // own references only; never a value the run read, never the AI's reason (that is the run's error text).
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS outcome_json TEXT`,
    // The last try-out of the item's plan (stores/coworkPlanTries.mts): which automation and fingerprint it tried, how
    // it ended, and whether the plan needs a passing one before it is approved (a plan Cowork drafted). Counts, step
    // titles and the plan's own sentences only; never a value the try-out read.
    `ALTER TABLE cowork_schedules ADD COLUMN IF NOT EXISTS plan_try_json TEXT`,
    // Sharing (usecases/coworkShares.mts): colleagues of the owner's organisation who may see the item (viewer) or
    // also decide its runs' questions (approver, at most one). The owner keeps the item; a share never runs it.
    `CREATE TABLE IF NOT EXISTS cowork_shares (
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        added_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (schedule_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cowork_shares_user ON cowork_shares (user_id)`,
    // What its owner chose before it started, and where its set-up stands (core/cowork/taskSetup.mts). `setup_state`:
    // 'wanted' (it is to get fixed steps), 'failed' (setting them up did not work) or 'ai' (its owner let the AI work
    // it out every run); NULL for an item nobody set up this way. While it is wanted or failed and no plan is approved,
    // the item does not start by itself (stores/coworkStore.js getDueSchedules, core/cowork/coworkRunner.js).
    // `setup_json`: who it sends to and whether its owner sees each message first, as chosen on the confirmation.
    `ALTER TABLE cowork_schedules ADD COLUMN IF NOT EXISTS setup_state TEXT`,
    `ALTER TABLE cowork_schedules ADD COLUMN IF NOT EXISTS setup_json TEXT`,
]);

module.exports = { PLAN_DDL };
