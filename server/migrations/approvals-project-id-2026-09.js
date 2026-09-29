/**
 * Migration: Solution membership on approvals (2026-09).
 *
 * ── Why a column and not a join ─────────────────────────────────────────────
 *
 * An approval could in principle inherit its project from its parent — the
 * automation it paused, or the app that asked. It must not, for one reason that
 * outranks the rest: APPROVALS ARE DESIGNED TO OUTLIVE THEIR PARENTS.
 * `run_id` is ON DELETE SET NULL, and `automation_id` / `studio_app_id` carry no
 * FK at all, precisely so deleting a routine cannot delete the record of a
 * decision someone made. A membership resolved through those pointers would
 * evaporate exactly when the row matters most — the approval whose automation
 * was deleted is the one you most need to still find in its project.
 *
 * So `project_id` is the same class of fact as the columns beside it:
 * `organization_id`, `automation_title`, `prompt`, `details_md` are all frozen
 * at request time so the record reads identically forever. This one answers
 * "which solution was this decision made inside", and that answer is history.
 *
 * ── Two deliberate divergences from the other member kinds ──────────────────
 *
 * 1. SET AT INSERT, NEVER UPDATED. There is no setApprovalProject. Re-filing an
 *    automation into another project moves its FUTURE approvals; it does not
 *    rewrite decisions already taken.
 *
 * 2. NOT CLEARED WHEN THE PROJECT IS DELETED. Every other kind detaches
 *    (clearProjectFrom*) so the resource survives its project. An approval is
 *    not a resource, it is a record: it keeps naming where the decision
 *    happened. `project_title` is snapshotted alongside for exactly the reason
 *    `automation_title` is — so the archived row still reads when the row it
 *    points at is gone.
 *
 * Also adds the automation_id index that buildApprovalWhere's `automationId`
 * narrowing filter has always needed and never had.
 *
 * Additive and idempotent.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_approvals ADD COLUMN IF NOT EXISTS project_id TEXT`);
    await exec(`ALTER TABLE automation_approvals ADD COLUMN IF NOT EXISTS project_title TEXT`);

    // Mirrors the shape of the existing viewer-scope indexes: the narrowing
    // filter is always ANDed with a status filter and ordered by created_at.
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_approvals_project
            ON automation_approvals(project_id, status, created_at DESC)
         WHERE project_id IS NOT NULL
    `);
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_approvals_automation
            ON automation_approvals(automation_id, created_at DESC)
         WHERE automation_id IS NOT NULL
    `);

    console.log('[Migration] approvals-project-id-2026-09 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
