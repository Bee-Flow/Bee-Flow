// @typecheck strict
/**
 * Migration: nested automation folders (2026-10).
 *
 * `parent_id` on automation_folders: NULL = top level, otherwise the folder it
 * sits in (same table). The tree rules (no loops, same organisation, depth
 * limit) are enforced by stores/automationStore/folderStore.mts; the database
 * adds the foreign key. ON DELETE SET NULL is only a backstop: deleteFolder
 * moves sub-folders up to the deleted folder's parent first, so a child is
 * never deleted and, in normal use, never flattened.
 *
 * Names were unique per organisation; now they are unique per PARENT
 * (organisation, parent, lower(name)), so two branches can both hold "Invoices".
 * The new index is wrapped like the old one: a migration that cannot re-run is
 * worse than one duplicate name.
 *
 * Idempotent: ADD COLUMN / CREATE INDEX IF NOT EXISTS, DROP INDEX IF EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_folders ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES automation_folders(id) ON DELETE SET NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_folders_parent ON automation_folders(parent_id) WHERE parent_id IS NOT NULL`);
    try {
        await exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_folders_name_parent
            ON automation_folders(COALESCE(organization_id, ''), COALESCE(parent_id, ''), LOWER(name))
        `);
        await exec(`DROP INDEX IF EXISTS idx_automation_folders_name`);
    } catch (e) {
        console.warn(`[Migration] automation-folder-parent-2026-10: unique name index skipped (${e.message})`);
    }
    console.log('[Migration] automation-folder-parent-2026-10 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
