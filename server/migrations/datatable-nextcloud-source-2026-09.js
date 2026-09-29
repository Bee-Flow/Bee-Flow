/**
 * Migration: `datatables.source` + `datatables.sync_state` (2026-09).
 *
 * Two nullable JSONB columns for a table whose ROWS come from somewhere else —
 * today a Nextcloud Tables table or view, mirrored into Bee Flow
 * (core/dataEngine/sources/nextcloudTable). `source` says where the rows come
 * from and how the columns map; `sync_state` says when they were last fetched
 * and whether that went well. NULL is an ordinary table and is what every
 * existing row correctly reads as, so there is nothing to backfill.
 *
 * `managed_kind = 'nextcloud_table'` is still the discriminator — every consumer
 * that already ships `managedKind` keeps working — and the two indexes below
 * are partial on it for the same reason idx_datatables_managed is: the
 * overwhelming majority of rows are ordinary tables.
 *
 * Both columns are ALSO emitted by datatableStore.createSchema, which runs on
 * every boot. Same reason as managed_kind: the store initialises independently
 * of this ladder, and a link against a column that does not exist yet is a 500
 * at exactly the moment somebody first tries the feature.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE datatables ADD COLUMN IF NOT EXISTS source JSONB`);
    await exec(`ALTER TABLE datatables ADD COLUMN IF NOT EXISTS sync_state JSONB`);
    // Webhook fan-out: "which mirrors in this organisation copy Nextcloud table N".
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_nc_table
                ON datatables (organization_id, ((source->>'ncTableId')::int))
                WHERE managed_kind = 'nextcloud_table'`);
    // The ticker: "which mirrors are due for a refresh". On the ISO TEXT, not
    // a ::timestamptz cast — that cast reads the session time zone and is
    // therefore not IMMUTABLE, which Postgres refuses in an index. The engine
    // always writes `toISOString()` (UTC, fixed width), so text order IS time
    // order and the ticker compares against an ISO string.
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_nc_due
                ON datatables ((sync_state->>'nextRunAt'))
                WHERE managed_kind = 'nextcloud_table'`);
}

module.exports = { up };
