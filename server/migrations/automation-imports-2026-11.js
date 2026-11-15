// @typecheck strict
/**
 * Migration: the import report of an automation that came from another workflow tool (2026-11).
 *
 * One table, `automation_imports`, one row per imported draft:
 *   id, org_id, user_id, automation_id   who imported what, into which organisation
 *   source_kind                          'windmill_upload' | 'windmill_api'
 *   windmill_path, windmill_generation   where it came from (a path, never an address or a token)
 *   report                               the migration report (stores/automationImportStore.mts)
 *   acknowledged                         checklist items the person marked as handled by hand
 *   dry_run_ok_at, dry_run_version       the last dry run that ended without an error, and on which version
 *   cleared_at                           when the draft first went live: from then on the gate is done
 *   created_at
 *
 * The row goes with its automation (ON DELETE CASCADE). Idempotent: IF NOT EXISTS only.
 */

/**
 * @param {{ exec?: (sql: string) => Promise<unknown> }} [opts]
 */
async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_imports (
            id TEXT PRIMARY KEY,
            org_id TEXT NULL,
            user_id TEXT NOT NULL,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            source_kind TEXT NOT NULL,
            windmill_path TEXT NULL,
            windmill_generation TEXT NULL,
            report JSONB NOT NULL DEFAULT '{}'::jsonb,
            acknowledged JSONB NOT NULL DEFAULT '[]'::jsonb,
            dry_run_ok_at TIMESTAMPTZ NULL,
            dry_run_version INTEGER NULL,
            cleared_at TIMESTAMPTZ NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS automation_imports_automation_idx ON automation_imports (automation_id);
        CREATE INDEX IF NOT EXISTS automation_imports_org_idx ON automation_imports (org_id, created_at DESC);
    `);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
