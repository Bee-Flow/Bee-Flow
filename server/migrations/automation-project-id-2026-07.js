/**
 * Migration: Studio Projects membership on automations (2026-07).
 *
 * A new nullable `project_id` column links an automation to the Studio Project
 * that contains it (projects.id). NULL = standalone automation (all pre-existing
 * rows) — a pure additive change, no backfill.
 *
 * Deliberately a soft reference (no hard FK), mirroring
 * direct_conversations.project_id: it avoids store-init ordering coupling,
 * and the project-delete route clears it explicitly (clearProjectFromAutomations)
 * so removing a project never deletes member automations.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS project_id TEXT`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automations_project ON automations(project_id) WHERE project_id IS NOT NULL`);
    console.log('[Migration] automation-project-id-2026-07 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
