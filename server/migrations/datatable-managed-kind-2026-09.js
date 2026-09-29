/**
 * Migration: `datatables.managed_kind` (2026-09).
 *
 * One nullable column marking a table whose COLUMNS the platform owns — today
 * the visible tier of the http_request response cache
 * (core/dataEngine/dataModel/managedTables.js). NULL is an ordinary table and
 * is what every existing row correctly reads as, so there is nothing to
 * backfill.
 *
 * The column is ALSO emitted by datatableStore.createSchema, which runs on
 * every boot. Both are here on purpose: the store initialises independently of
 * this migration ladder, and provisioning a cache table against a column that
 * does not exist yet is a 500 at exactly the moment somebody first tries the
 * feature. Two idempotent statements, one reason.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE datatables ADD COLUMN IF NOT EXISTS managed_kind TEXT`);
    // Partial: the overwhelming majority of rows are ordinary tables and index
    // entries for them would be dead weight. The picker's question is only ever
    // "which tables of THIS kind are there", which is exactly what this answers.
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_managed
                ON datatables(scope_kind, scope_id, managed_kind)
                WHERE managed_kind IS NOT NULL`);
}

module.exports = { up };
