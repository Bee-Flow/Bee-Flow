/**
 * Migration: folders for automations (2026-08).
 *
 * One flat level, shared across the organisation — the same shape as
 * `agent_categories` / `kb_categories`, which is the grouping pattern that
 * actually ships here. Deliberately NOT the older `folders` table in
 * stores/workflowStore.js: that one is owner-scoped, nested, has no routes or
 * UI anywhere, and its delete removes the contained rows.
 *
 * `automations.folder_id` is a soft reference (no hard FK), like `project_id`
 * above it: deleting a folder must DETACH its automations, never delete them.
 * That matters more here than for projects — folders are org-wide, so a folder
 * can hold routines belonging to colleagues this user cannot even see.
 *
 * Idempotent: CREATE TABLE / ADD COLUMN / CREATE INDEX all IF NOT EXISTS. The
 * unique index is wrapped because an existing installation could already hold
 * two folders differing only in case, and a migration that cannot re-run is
 * worse than one duplicate name.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_folders (
            id TEXT PRIMARY KEY,
            organization_id TEXT,
            name TEXT NOT NULL,
            icon TEXT DEFAULT '📁',
            color TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_folders_org ON automation_folders(organization_id)`);
    try {
        await exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_folders_name
            ON automation_folders(COALESCE(organization_id, ''), LOWER(name))
        `);
    } catch (e) {
        console.warn(`[Migration] automation-folders-2026-08: unique name index skipped (${e.message})`);
    }

    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS folder_id TEXT`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automations_folder ON automations(folder_id) WHERE folder_id IS NOT NULL`);
    console.log('[Migration] automation-folders-2026-08 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
