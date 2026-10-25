// @typecheck strict
/**
 * Migration: automation_run_tables (2026-10).
 *
 * The ledger for tables a run produced (the `read_table` and `table` steps).
 * A table is NOT a generated file: it has its own columns, row count and
 * reader, and it must never be reachable through the surfaces that serve
 * generated files to anonymous form visitors, approval snapshots or the MCP
 * file list. A separate table keeps those paths structurally unable to see it.
 *
 * `run_id` and `automation_id` carry ON DELETE SET NULL, NOT cascade. Run
 * retention and the trash purge delete runs and automations whenever they like,
 * and object storage has no foreign keys: a cascade would drop the row and
 * leave its blob (full row data) behind for good, with nothing left to find it
 * by. With SET NULL the row survives as an orphan (no run, no automation, so no
 * read path can reach it) and the reaper deletes the bytes first and the row
 * second, for orphans as well as expired rows. A live row without bytes answers
 * a clean 404; a live blob without a row would be garbage nothing comes back for.
 *
 * Every blob key is unique to its row (never content-addressed), so deleting
 * one row's blob cannot take another row's data with it.
 *
 * `expires_at` is NOT NULL on purpose, as for generated files.
 *
 * Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_run_tables (
            id TEXT PRIMARY KEY,
            run_id TEXT REFERENCES automation_runs(id) ON DELETE SET NULL,
            automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
            step_id TEXT,
            storage_key TEXT NOT NULL,
            name TEXT NOT NULL,
            columns JSONB NOT NULL,
            row_count BIGINT NOT NULL DEFAULT 0,
            size_bytes BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_automation_run_tables_run ON automation_run_tables(run_id);
        CREATE INDEX IF NOT EXISTS idx_automation_run_tables_expiry ON automation_run_tables(expires_at);
        CREATE INDEX IF NOT EXISTS idx_automation_run_tables_orphan ON automation_run_tables(created_at)
            WHERE run_id IS NULL OR automation_id IS NULL;

        -- A database that already ran the first version of this migration (cascade, NOT NULL).
        ALTER TABLE automation_run_tables ALTER COLUMN run_id DROP NOT NULL;
        ALTER TABLE automation_run_tables ALTER COLUMN automation_id DROP NOT NULL;
        ALTER TABLE automation_run_tables DROP CONSTRAINT IF EXISTS automation_run_tables_run_id_fkey;
        ALTER TABLE automation_run_tables ADD CONSTRAINT automation_run_tables_run_id_fkey
            FOREIGN KEY (run_id) REFERENCES automation_runs(id) ON DELETE SET NULL;
        ALTER TABLE automation_run_tables DROP CONSTRAINT IF EXISTS automation_run_tables_automation_id_fkey;
        ALTER TABLE automation_run_tables ADD CONSTRAINT automation_run_tables_automation_id_fkey
            FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE SET NULL;
    `);

    console.log('[Migration] automation-run-tables-2026-10 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
