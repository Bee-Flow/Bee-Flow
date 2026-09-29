/**
 * The vocabulary of a SOURCE MIRROR — a datatable whose rows are a copy of
 * something that lives elsewhere and is kept in step with it: a Nextcloud
 * Tables table, or one worksheet of a spreadsheet file in Google Drive,
 * OneDrive or Nextcloud Files.
 *
 * Two kinds, one surface: the detail view, the row browser, the column
 * designer and the list card all ask "is this a mirror, what is it a mirror
 * OF, may its rows be written, what does this refusal mean" — and the word
 * that answers the second question is what fills every `{source}`
 * placeholder in the shared `src_*` sentences.
 *
 * A LEAF beside datatableDisplay.js (which re-exports all of it, so every
 * consumer keeps one import path): pure, no React, no lucide — the glyphs
 * live in sourceGlyphs.js — and split out only so neither module outgrows
 * the lint budget. The kinds themselves are pinned against the server in
 * datatableDisplay.vocabulary.test.js through SOURCE_MANAGED_KINDS.
 */

/**
 * Kinds whose ENTIRE column list belongs to an external source — mirrors the
 * server's `fieldsFromSource` flag (managedTables.js). Every column is locked,
 * nothing can be added, and a schema save is refused outright
 * (`schema_from_source`).
 */
export const SOURCE_MANAGED_KINDS = Object.freeze(['nextcloud_table', 'spreadsheet_file']);

/** A table that mirrors ANY external source (either kind). */
export function isSourceMirror(table) {
    return SOURCE_MANAGED_KINDS.includes(table?.managedKind);
}

/** A table that mirrors a Nextcloud Tables table or view. */
export function isNcMirror(table) {
    return table?.managedKind === 'nextcloud_table';
}

/** A table that mirrors one worksheet of a spreadsheet file. */
export function isSpreadsheetMirror(table) {
    return table?.managedKind === 'spreadsheet_file';
}

/**
 * The storages a spreadsheet can be linked from. Proper nouns, so they are
 * NOT translated: "Google Drive" is Google Drive in every language, and a
 * dictionary entry for it would only be a place for it to drift.
 */
export const PROVIDERS = Object.freeze(['google_drive', 'onedrive', 'nextcloud_files']);
const PROVIDER_NAMES = Object.freeze({ google_drive: 'Google Drive', onedrive: 'OneDrive', nextcloud_files: 'Nextcloud' });

export function providerName(provider) {
    return PROVIDER_NAMES[provider] || provider || '';
}

/**
 * The brand mark for a file (utils/integrationLogos ids). A native Google
 * Sheet wears the Sheets logo, not Drive's — it is the sheet the person
 * recognises, and the file is only ever seen through it.
 */
export function providerLogoId(provider, format) {
    if (format === 'gsheet') return 'google_sheets';
    if (provider === 'nextcloud_files') return 'nextcloud';
    return provider || null;
}

/** The file formats the server can link; mirrors spreadsheetFile.FORMATS. */
export const FORMATS = Object.freeze(['xlsx', 'xlsm', 'xls', 'csv', 'ods', 'gsheet']);

/** What a format is called on screen — with its extension, which is what the person sees in the folder. */
export function formatLabel(t, format) {
    switch (format) {
        case 'xlsx': return t('datatables.ss_format_xlsx', 'Excel workbook (.xlsx)');
        case 'xlsm': return t('datatables.ss_format_xlsm', 'Excel workbook with macros (.xlsm)');
        case 'xls': return t('datatables.ss_format_xls', 'Excel 97–2003 workbook (.xls)');
        case 'csv': return t('datatables.ss_format_csv', 'CSV file');
        case 'ods': return t('datatables.ss_format_ods', 'OpenDocument spreadsheet (.ods)');
        case 'gsheet': return t('datatables.ss_format_gsheet', 'Google Sheet');
        default: return format ? String(format) : '';
    }
}

/**
 * The word that fills every `{source}` placeholder: "Nextcloud" for a Tables
 * mirror, the storage's name for a spreadsheet. The English the Nextcloud
 * kind renders through the shared `src_*` sentences is byte-for-byte what
 * its own `nc_*` sentences said, which is what lets one component serve both.
 */
export function sourceNameOf(table, source = table?.source) {
    if (isNcMirror(table)) return 'Nextcloud';
    if (isSpreadsheetMirror(table)) return providerName(source?.provider);
    return '';
}

/** The table (or view) in Nextcloud's own Tables app — the server's deep link. */
export function ncUrlOf(source) {
    if (!source || !source.ncTableId) return null;
    return source.ncUrl || `/apps/tables/#/${source.ncViewId ? `view/${source.ncViewId}` : `table/${source.ncTableId}`}`;
}

/** Where "Open in {source}" goes, or null when the source has no page to open. */
export function sourceUrlOf(table, source = table?.source) {
    if (isNcMirror(table)) return ncUrlOf(source);
    if (isSpreadsheetMirror(table)) return source?.webUrl || null;
    return null;
}

/**
 * May rows be CHANGED here and written through to the source? A Nextcloud
 * mirror always; a spreadsheet only when the server could find a way to
 * write the file (`writable`) — an .xls, a file the linker does not own, a
 * file without write permission are read here and changed in the file.
 */
export function sourceWritable(table, source = table?.source) {
    return isSourceMirror(table) && source?.writable !== false;
}

/**
 * The GLYPH a table wears, as distinct from its kind. A mirror IS a datatable
 * (same colour, same place in Studio) but a person scanning the list should
 * see at a glance which tables are really somebody else's — so a Nextcloud
 * mirror gets the cloud and a spreadsheet mirror the sheet, not the grid.
 * Returns null for "the kind's own icon". The component behind each name
 * lives in sourceGlyphs.js, so this module stays free of React.
 */
export function tableIconOf(table) {
    if (isNcMirror(table)) return 'nextcloud';
    if (isSpreadsheetMirror(table)) return 'spreadsheet';
    if (table?.managedKind === 'form_answers') return 'form';
    return null;
}

/**
 * Why a spreadsheet is read here but not written — `source.writeReason` when
 * `writeMode` is `none`. The server names the mechanism it lacks; this names
 * what the person can do about it.
 */
export function writeReasonText(t, reason) {
    switch (reason) {
        case 'xls':
            return t('datatables.ss_write_reason_xls', 'An Excel 97–2003 file (.xls) is read here but not written. Save it as .xlsx to write rows back.');
        case 'xlsm':
            return t('datatables.ss_write_reason_xlsm', 'A workbook with macros (.xlsm) is read here but not written — writing it would drop the macros. Save a copy as .xlsx to write rows back.');
        case 'ods':
            return t('datatables.ss_write_reason_ods', 'An OpenDocument spreadsheet (.ods) is read here but not written. Save it as .xlsx to write rows back.');
        case 'not_owned':
            return t('datatables.ss_write_reason_not_owned', 'The file belongs to someone else. Rows are read here; writing into a shared file is switched on per file by the account that links it.');
        case 'no_permission':
            return t('datatables.ss_write_reason_no_permission', 'The account that linked this table may not change the file.');
        default:
            return null;
    }
}

/**
 * The one-line caveat that goes with a write mode — what is kept and what is
 * lost when a row is written back. Shown beside a file in the link wizard
 * and under the write card of the panel, so the sentence is here once.
 */
export function writeCaveatText(t, writeMode, reason = null) {
    switch (writeMode) {
        case 'sheets_api':
            return t('datatables.ss_caveat_sheets_api', 'Rows are written into the sheet cell by cell; number formats are kept.');
        case 'graph_workbook':
            return t('datatables.ss_caveat_graph_workbook', 'Rows are written into the workbook cell by cell; formatting is kept.');
        case 'exceljs_put':
            return t('datatables.ss_caveat_exceljs_put', 'Cell styles, column widths and number formats are kept when rows are written back; charts, pivot tables and macros in the file are not.');
        case 'csv_put':
            return t('datatables.ss_caveat_csv_put', 'The whole file is rewritten when a row changes — same delimiter, encoding and line endings as found.');
        case 'none':
            return writeReasonText(t, reason) || t('datatables.ss_caveat_none', 'This file is read here; rows cannot be changed from Bee Flow.');
        default:
            return null;
    }
}

/**
 * What each machine-readable refusal a Nextcloud mirror can answer with means
 * to a person — the ONE switch for row writes, schema saves and settings.
 * Returns null for a code this module does not know, so the caller keeps its
 * own default. The codes are the server's (core/dataEngine/sources/
 * nextcloudTable/errors.js); `{detail}` is Nextcloud's own sentence where the
 * server passes one on, shown verbatim.
 */
export function ncErrorMessage(t, err) {
    const detail = err?.message || '';
    switch (err?.code) {
        case 'nextcloud_forbidden':
            return t('datatables.err_nextcloud_forbidden', 'Nextcloud refused this change: the account that linked this table may not change it there.');
        case 'nextcloud_not_found':
            return t('datatables.err_nextcloud_not_found', 'Nextcloud no longer has this row or table.');
        case 'nextcloud_rejected':
            return t('datatables.err_nextcloud_rejected', 'Nextcloud did not accept the row: {detail}', { detail });
        case 'nextcloud_unavailable':
        case 'linker_unavailable':
            return t('datatables.err_nextcloud_unavailable', 'Nextcloud could not be reached, so nothing was changed on either side. Try again in a moment.');
        case 'nc_scope_denied':
            return t('datatables.err_nc_scope_denied', 'The account that linked this table no longer shares it with Bee Flow. Ask an owner to re-link it.');
        case 'nextcloud_integration_off':
            return t('datatables.err_nextcloud_integration_off', 'Nextcloud Tables is switched off for this organisation.');
        case 'not_nc_org':
            return t('datatables.err_not_nc_org', 'This organisation is not connected to Nextcloud.');
        case 'schema_from_source':
            return t('datatables.err_schema_from_source', 'The columns of this table are Nextcloud’s. Change them in Nextcloud — the next refresh brings them here.');
        case 'derived_column':
            return t('datatables.err_derived_column', 'That column is filled in from a relation and cannot be set directly.');
        case 'mirror_no_retention':
            return t('datatables.err_mirror_no_retention', 'Rows of a Nextcloud table are not aged out here.');
        case 'mirror_row_scope':
            return t('datatables.err_mirror_row_scope', 'A Nextcloud table cannot be limited to each person’s own rows — every row was written by the account that linked it.');
        case 'already_linked':
            return t('datatables.err_already_linked', 'That Nextcloud table is already linked here.');
        case 'nextcloud_write_unsupported':
            return t('datatables.err_nextcloud_write_unsupported', 'Rows of this table can be changed in Nextcloud for now; changes arrive here on refresh.');
        default:
            return null;
    }
}

/**
 * The same switch for a SPREADSHEET mirror — the codes of core/dataEngine/
 * sources/spreadsheetFile/errors.js. `storage` is the word for the file's
 * home ("Google Drive"); when the caller has no table yet (the link wizard)
 * it is read off the error's `ref`, and failing that it is "the storage".
 * `{detail}` is the file's own sentence where the server passes one on.
 *
 * `linked` says whether the error is about a table that EXISTS. The storage
 * word cannot tell the two apart — the wizard names a storage too — and one
 * code means two different things: a Nextcloud scope refusal during
 * browsing, describing or linking is about the CALLER'S own folder
 * selection (the remedy is in their own Settings → Connections), while the
 * same refusal on a linked table is about the linker's, whom only an owner
 * can replace by re-linking. sourceErrorMessage sets it; the wizard never does.
 *
 * A file that moved or a sheet that went says "unlink and link again": that
 * is the affordance the surface has. "Re-read the columns" re-probes the
 * SAME stored path, so promising that an owner can "point the table at the
 * file again" would send them to a button that answers the same refusal.
 */
export function ssErrorMessage(t, err, storage = null, { linked = false } = {}) {
    const body = err?.body || {};
    const source = storage || providerName(body.ref?.provider || body.provider) || t('datatables.ss_the_storage', 'the storage');
    const detail = err?.message || '';
    switch (err?.code) {
        case 'provider_not_connected':
            return body.detail === 'needs_reauth'
                ? t('datatables.ss_err_provider_needs_reauth', 'The {source} connection has expired. Renew it under Settings → Connections.', { source })
                : t('datatables.ss_err_provider_not_connected', '{source} is not connected for this account. Connect it under Settings → Connections.', { source });
        case 'provider_integration_off':
            return t('datatables.ss_err_provider_integration_off', '{source} is switched off for this organisation.', { source });
        case 'nc_scope_denied':
            return linked
                ? t('datatables.err_nc_scope_denied', 'The account that linked this table no longer shares it with Bee Flow. Ask an owner to re-link it.')
                : t('datatables.ss_reason_nc_scope_off', 'Bee Flow may not read this account’s Nextcloud files yet. Choose folders under Settings → Connections → Nextcloud.');
        case 'spreadsheet_forbidden':
            return t('datatables.ss_err_spreadsheet_forbidden', '{source} refused this change: the account that linked this table may not change the file.', { source });
        case 'spreadsheet_not_found':
            return t('datatables.ss_err_spreadsheet_not_found', 'The file is no longer where it was in {source}. Unlink this table and link the file again from its new place.', { source });
        case 'sheet_missing':
            return t('datatables.ss_err_sheet_missing', 'The sheet is no longer in the file. Unlink this table and link the sheet you want.');
        case 'spreadsheet_conflict':
            return t('datatables.ss_err_spreadsheet_conflict', 'The file changed while this row was being written, so nothing was changed. The rows are refreshed — try again.');
        case 'spreadsheet_locked':
            return t('datatables.ss_err_spreadsheet_locked', 'The file is locked by someone else right now. Try again in a moment.');
        case 'already_linked':
            return t('datatables.ss_err_already_linked', 'That sheet is already linked here.');
        case 'key_duplicate':
            return t('datatables.ss_err_key_duplicate', 'A row with that key is already in the sheet: {detail}', { detail });
        case 'spreadsheet_write_unsupported':
            return writeReasonText(t, body.reason)
                || t('datatables.ss_err_write_unsupported', 'Rows of this table are read from the file and cannot be changed from here.');
        case 'spreadsheet_too_large':
            return t('datatables.ss_err_spreadsheet_too_large', 'The file is too large to keep in step here.');
        case 'format_unsupported':
            return t('datatables.ss_err_format_unsupported', 'This file type cannot be linked.');
        case 'header_missing':
            return t('datatables.ss_err_header_missing', 'That row does not look like a header row.');
        case 'key_missing':
            return t('datatables.ss_err_key_missing', 'The key column is empty for this row, so the row cannot be told apart from the others.');
        case 'key_not_unique':
            return t('datatables.ss_err_key_not_unique', '“{header}” is not unique in the sheet, so it cannot identify a row.', { header: body.header || detail });
        case 'spreadsheet_rejected':
            return t('datatables.ss_err_spreadsheet_rejected', 'The file did not accept the row: {detail}', { detail });
        case 'spreadsheet_unavailable':
        case 'linker_unavailable':
            return t('datatables.ss_err_spreadsheet_unavailable', '{source} could not be reached, so nothing was changed on either side. Try again in a moment.', { source });
        case 'schema_from_source':
            return t('datatables.ss_err_schema_from_source', 'The columns of this table come from the file. Change them in the file — “Re-read the columns” brings them here.');
        case 'mirror_no_retention':
            return t('datatables.ss_err_mirror_no_retention', 'Rows of a linked spreadsheet are not aged out here.');
        case 'mirror_row_scope':
            return t('datatables.ss_err_mirror_row_scope', 'A linked spreadsheet cannot be limited to each person’s own rows — every row was written by the account that linked it.');
        case 'derived_column':
            return t('datatables.err_derived_column', 'That column is filled in from a relation and cannot be set directly.');
        case 'no_shared_root':
            return t('datatables.ss_err_no_shared_root', '{source} has no “shared with me” folder to browse.', { source });
        default:
            return null;
    }
}

/**
 * The refusal switch for whichever kind `table` is. Without a table (the
 * dialogs, before one exists) the Nextcloud sentence wins where both kinds
 * use a code, which is what those dialogs said before spreadsheets existed.
 * A spreadsheet table that exists is `linked`: its refusals are about the
 * account that linked it, not about whoever is looking.
 */
export function sourceErrorMessage(t, err, table = null) {
    if (isNcMirror(table)) return ncErrorMessage(t, err);
    if (isSpreadsheetMirror(table)) return ssErrorMessage(t, err, sourceNameOf(table), { linked: true });
    return ncErrorMessage(t, err) || ssErrorMessage(t, err);
}

/**
 * What differs between the two kinds on the shared surface — and ONLY that.
 * Everything a component can say with a `{source}` word is a `src_*`
 * sentence it calls itself; what is here is prose with a shape of its own
 * per kind (how "live" works, what a cap means, what unlinking leaves alone).
 *
 * Entries are FUNCTIONS over `t`, never bare keys: the i18n guard finds
 * translation keys at literal `t('…')` call sites, and a key carried as a
 * string would be one it could not see.
 */
export const SOURCE_KINDS = Object.freeze({
    nextcloud_table: Object.freeze({
        kind: 'nextcloud_table',
        icon: 'nextcloud',
        tabLabel: (t) => t('datatables.tab_nextcloud', 'Nextcloud'),
        liveExplain: (t) => t('datatables.nc_live_explain', 'Changes in Nextcloud appear here within seconds while the table is open; in the background it is checked every minute, and Nextcloud pushes changes as they happen.'),
        truncated: (t, n) => t('datatables.nc_truncated', 'Not every row was copied — the copy is capped at {n} rows. Filter the view in Nextcloud, or link a view instead.', { n }),
        unlinkNotice: (t) => t('datatables.nc_unlink_notice', 'Unlinking removes the copy kept here. The table in Nextcloud, and every row in it, stays exactly as it is. Automations and apps that use this table stop finding it.'),
        linkedBody: (t, n) => (n === 1
            ? t('datatables.nc_linked_body_one', 'The table is being filled in from Nextcloud now. Automations and apps can use it like any other table.')
            : t('datatables.nc_linked_body', '{n} tables are being filled in from Nextcloud now. Automations and apps can use them like any other table.', { n })),
    }),
    spreadsheet_file: Object.freeze({
        kind: 'spreadsheet_file',
        icon: 'spreadsheet',
        tabLabel: (t) => t('datatables.ss_tab', 'Spreadsheet'),
        liveExplain: (t) => t('datatables.ss_live_explain', 'Changes in the file appear here within seconds while the table is open; in the background the file is checked every minute. Only the file’s version is checked — it is read again only when it changed.'),
        truncated: (t, n) => t('datatables.ss_truncated', 'Not every row was copied — the copy is capped at {n} rows. Split the sheet, or link a smaller one.', { n }),
        unlinkNotice: (t, source) => t('datatables.ss_unlink_notice', 'Unlinking removes the copy kept here. The file in {source}, and every row in it, stays exactly as it is. Automations and apps that use this table stop finding it.', { source }),
        linkedBody: (t, n) => (n === 1
            ? t('datatables.ss_linked_body_one', 'The table is being filled in from the file now. Automations and apps can use it like any other table.')
            : t('datatables.ss_linked_body', '{n} tables are being filled in from the files now. Automations and apps can use them like any other table.', { n })),
    }),
});

/** The registry entry for a table's kind, or null for a table that mirrors nothing. */
export function sourceKindSpec(table) {
    return SOURCE_KINDS[table?.managedKind] || null;
}
