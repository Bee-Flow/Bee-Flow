/**
 * Migration: automation_approvals — the approval as a PRODUCT object (2026-08).
 *
 * Until now "an approval" was a state a RUN could be in: automation_runs
 * carried awaiting_step_id / awaiting_step_expires_at, the rendered question
 * lived on the awaiting step row's output, and the only queryable surfaces
 * were owner-scoped run lists. Three requirements broke that model at once:
 *
 *   1. AUDIT. "Who approved this and why" must be answerable long after the
 *      run is gone — and run retention (jobs/runRetention.js) deletes terminal
 *      runs after 90 days. The old automation_approval_audit shell even had an
 *      ON DELETE CASCADE FK to runs, so retention would have silently emptied
 *      the very trail it existed to keep.
 *   2. VISIBILITY. Members see their own approvals, group members see their
 *      group's, org admins see the organisation's. Runs have no org column,
 *      and buildRunFilterWhere is contractually user-scoped — org visibility
 *      cannot be bolted onto the engine's hottest table.
 *   3. FIDELITY. The detail view must show what the approver saw AT PAUSE
 *      TIME. The run state the templates referenced is unrecoverable later,
 *      so the rendered prompt/details/fields/attachments are SNAPSHOTTED here
 *      (the same reason a paused form page snapshots its rendered config).
 *
 * So: the run keeps its awaiting_* columns as the engine's mechanism; this row
 * is the durable decision record. `run_id` is ON DELETE SET NULL — the
 * approval outlives the run, deliberately. `automation_id` has NO FK for the
 * same reason: deleting a routine must not delete the record that someone
 * approved something under it.
 *
 * organization_id is stamped at creation from the owner's org and is
 * intentionally frozen: if the owner later moves org, historical approvals
 * stay with the org they were decided in — that is what an audit means.
 *
 * The old automation_approval_audit table is repurposed as this feature's
 * append-only EVENT log (requested / approved / rejected / expired /
 * cancelled): its run FK is dropped (events must outlive runs too) and it
 * gains approval_id. Existing rows: there are none — the table shipped as an
 * empty shell and nothing ever wrote to it.
 *
 * Idempotent throughout.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_approvals (
            id TEXT PRIMARY KEY,
            organization_id TEXT,
            automation_id TEXT,
            automation_title TEXT NOT NULL DEFAULT '',
            run_id TEXT REFERENCES automation_runs(id) ON DELETE SET NULL,
            root_run_id TEXT,
            step_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            assignee_user_id TEXT,
            assignee_group_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            prompt TEXT NOT NULL DEFAULT '',
            details_md TEXT,
            fields JSONB,
            attachments JSONB,
            answers JSONB,
            decided_by TEXT,
            decided_by_name TEXT,
            decision_reason TEXT,
            decided_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // The four viewer scopes, each with its own leading column so no scope
    // ever scans another's rows: owner ("my routines' approvals"), assignee
    // ("waiting on me"), group ("waiting on my team"), org (the admin view).
    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_owner
                    ON automation_approvals (owner_id, status, created_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_assignee
                    ON automation_approvals (assignee_user_id, status, created_at DESC)
                 WHERE assignee_user_id IS NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_group
                    ON automation_approvals (assignee_group_id, status, created_at DESC)
                 WHERE assignee_group_id IS NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_org
                    ON automation_approvals (organization_id, status, created_at DESC)
                 WHERE organization_id IS NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_run
                    ON automation_approvals (run_id) WHERE run_id IS NOT NULL`);
    // One PENDING approval per paused step. This is both a correctness
    // invariant (the pause path and the lazy backfill can race — ON CONFLICT
    // DO NOTHING resolves it) and the double-decide guard's foundation.
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_approvals_pending_run_step
                    ON automation_approvals (run_id, step_id) WHERE status = 'pending'`);

    // ── Repurpose the audit shell as the append-only event log ───────────
    // The FK made audit rows die with their run under retention — the one
    // property an audit table must not have.
    await exec(`ALTER TABLE automation_approval_audit DROP CONSTRAINT IF EXISTS fk_approval_audit_run`);
    await exec(`ALTER TABLE automation_approval_audit ADD COLUMN IF NOT EXISTS approval_id TEXT`);
    // run_id must also stop being NOT NULL (automation-extras-2026-06 declared
    // it so, back when an approval WAS a run state). The log is keyed on
    // approval_id now, and approvals-v2 made the source-agnostic case real:
    //   - an App Studio `request_approval` approval has no run at all;
    //   - 'hook_ran' / 'hook_failed' events pass no runId for ANY approval
    //     (automation/approvalHooks.js).
    // Every appendApprovalAudit call site ends in `.catch(() => {})` — correct,
    // since an audit write must never fail a decision — so the NOT NULL
    // violation threw into a swallowed promise and those events simply were
    // not there. Relaxing it is rolling-deploy safe in both directions: the
    // old code always supplied run_id, and no existing row is touched.
    await exec(`ALTER TABLE automation_approval_audit ALTER COLUMN run_id DROP NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approval_audit_approval
                    ON automation_approval_audit (approval_id, ts DESC)`);

    console.log('[Migration] automation-approvals-2026-08 applied');
}

module.exports = { up };
