/**
 * Migration: the second source kind's indexes (2026-09).
 *
 * `datatables.source` and `datatables.sync_state` (datatable-nextcloud-source-
 * 2026-09) now also carry a mirror of ONE worksheet of a spreadsheet file in
 * Google Drive, OneDrive or Nextcloud Files — `managed_kind = 'spreadsheet_file'`
 * (core/dataEngine/sources/spreadsheetFile). Same columns, same discriminator
 * idea, two more partial indexes:
 *
 *   • the file-event fan-out: "which mirrors in this organisation copy file F
 *     at storage P" — on the provider and the file id INSIDE the source block;
 *   • the ticker's due list over BOTH kinds, so one job (jobs/datatableNcSync)
 *     asks one question. The Nextcloud-only `idx_datatables_nc_due` stays: an
 *     index nobody asks by any more costs a little on write and nothing on
 *     read, and dropping it in the same release as the query that used it
 *     would leave a downgraded replica without either.
 *
 * TEXT expressions only. `source->>'…'` and `source->'file'->>'id'` are
 * IMMUTABLE; a `::int` or `::timestamptz` cast on them is not (it reads the
 * session's settings) and Postgres refuses it in an index — which is exactly
 * what the first draft of the Nextcloud migration ran into. The kinds in the
 * WHERE are spelled out as constants: the store inlines the same literal list
 * into its queries, because a bound parameter cannot prove a partial-index
 * predicate to the planner.
 *
 * Both indexes are ALSO emitted by datatableStore.createSchema, which runs on
 * every boot — the store initialises independently of this ladder.
 */

const { exec } = require('../db');

async function up() {
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_source_file
                ON datatables (organization_id, (source->>'provider'), (source->'file'->>'id'))
                WHERE managed_kind = 'spreadsheet_file'`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_source_due
                ON datatables ((sync_state->>'nextRunAt'))
                WHERE managed_kind IN ('nextcloud_table', 'spreadsheet_file')`);
}

module.exports = { up };
