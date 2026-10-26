// @typecheck strict
/**
 * Kick the refresh of ONE mirror through the engine of its own kind, without
 * going through the registry (../index.js): an events module reaches this to
 * refresh a dependent of ANOTHER kind, and the registry hands out the adapters
 * that own those events modules (import cycle). The kind -> sync map is the
 * only place besides the registry that names the kinds; each module is
 * required on first use, so loading this file loads no kind.
 */

'use strict';

/** @type {Record<string, () => { kickStale: (table: any, opts?: any) => any }>} */
const SYNC_OF_KIND = {
    nextcloud_table: () => require('../nextcloudTable/sync'),
    spreadsheet_file: () => require('../spreadsheetFile/sync'),
};

/**
 * @param {{ managedKind?: string | null } | null | undefined} table
 * @param {{ reason?: string, delayMs?: number }} [opts]
 * @returns {unknown} false when the table is not a source mirror
 */
function kickStale(table, opts) {
    const kind = table && table.managedKind;
    const load = typeof kind === 'string' ? SYNC_OF_KIND[kind] : undefined;
    return load ? load().kickStale(table, opts) : false;
}

module.exports = { kickStale };
