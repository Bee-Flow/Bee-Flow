/**
 * A DATATABLE THAT MIRRORS ONE WORKSHEET OF A SPREADSHEET FILE — the engine
 * behind `managed_kind = 'spreadsheet_file'`.
 *
 * The file lives in the user's own storage — Google Drive (incl. a native
 * Google Sheet), OneDrive, or Nextcloud Files — and stays the truth: the
 * mirror copies its rows into an ordinary datatable (so routines, agents,
 * App Studio, knowledge bases and the webpage bridge read it like any other),
 * re-checks the file's version marker whenever somebody looks (the 5 s pulse),
 * every minute in the background, and on a push event where the storage has
 * one, and writes rows changed in Bee Flow INTO THE FILE FIRST.
 *
 * What differs from the Nextcloud Tables mirror (../nextcloudTable):
 *   • a sheet has no row ids — identity.js derives one from a KEY COLUMN the
 *     linker chose, else from the row number (`r<n>`);
 *   • columns are the header row; their types are INFERRED once (infer.js)
 *     and then declared, never re-inferred from data;
 *   • there is no cell API on most storages — a "change" means downloading
 *     the file when its marker moved, and a write means editing the file in
 *     place (exceljs for xlsx, a byte-faithful rewrite for csv) under an
 *     etag-guarded PUT.
 *
 * The generic pipeline (claim → columns → snapshot → upsert → sweep → finish,
 * probe-then-source-then-rewrite write-through) lives in ../mirror; this
 * folder only knows about files, sheets and the three storages.
 *
 * LAYER: core/. Uses stores/, auth/, the compiler, integrations/google*,
 * integrations/msGraph*, integrations/nextcloud* (platform integrations —
 * layering.test.js allows it).
 */

'use strict';

const KIND = 'spreadsheet_file';

const PROVIDERS = Object.freeze(['google_drive', 'onedrive', 'nextcloud_files']);
const FORMATS = Object.freeze(['xlsx', 'xlsm', 'xls', 'csv', 'ods', 'gsheet']);

/** How a change from Bee Flow reaches the file. `none` carries a `reason`. */
const WRITE_MODES = Object.freeze(['sheets_api', 'graph_workbook', 'exceljs_put', 'csv_put', 'none']);

/** Is this datatable row a spreadsheet mirror? */
function isMirror(table) {
    return !!table && table.managedKind === KIND;
}

module.exports = { KIND, PROVIDERS, FORMATS, WRITE_MODES, isMirror };
