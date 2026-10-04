/**
 * Migration: deployment-sourced approvals (2026-10).
 *
 * A PRD deployment of a Solution that needs approval asks through the same
 * `automation_approvals` table as a paused run or an App Studio request:
 * `source = 'deployment'`, `step_id = 'stage.prd'` (a non-null sentinel), and
 * this new `deployment_id` column pointing at `solution_deployments.id`.
 *
 * ── Why there is NO CHECK change ────────────────────────────────────────────
 *
 * `approvals_source_shape` (`source = 'app' OR step_id IS NOT NULL`) is added
 * by approvals-v2-2026-09.js, which replays on every boot and re-adds the
 * constraint whenever one with that name is absent. Dropping or renaming it
 * here would make the next boot re-add the old predicate with a full scan
 * under ACCESS EXCLUSIVE. The sentinel step id keeps a deployment row inside
 * the existing predicate, so the constraint is left alone.
 *
 * `run_id` is NULL for a deployment row, so the pending-unique
 * `ON CONFLICT (run_id, step_id)` never collides (NULLs are distinct).
 *
 * Additive and idempotent: IF NOT EXISTS only.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_approvals ADD COLUMN IF NOT EXISTS deployment_id TEXT`);
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_approvals_deployment
            ON automation_approvals(deployment_id)
         WHERE deployment_id IS NOT NULL
    `);
    console.log('[Migration] approvals-deployment-source-2026-10 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
