/**
 * The ONE error shape a spreadsheet mirror answers with — the same contract as
 * ../nextcloudTable/errors.js, read by the same three callers:
 *   • routes answerDatatableError reads `status` + string `code`
 *   • the runner's on_error branches match `errorClass`
 *   • records.js sourceRefusal / datatableRuntime pass a `safe` error through
 * `ref` names the file/sheet the error is about ({ provider, fileId, sheet })
 * so a wizard can mark the right row — `fileId` is the SAME id the browser
 * handed out (the path on Nextcloud, `drive|item` for a foreign OneDrive
 * item), or the mark never lands; `detail` is the storage's own sentence,
 * bounded, never a URL or a token; `header` names the column a key refusal
 * is about and `key` the technical name a `key_taken` is about. The route
 * serialises every one of these it finds — the client builds its sentence
 * from the fields, not from the message.
 */

'use strict';

const { SourceError, MAX_DETAIL } = require('../mirror/errors');

const ERROR_CLASS = Object.freeze({
    provider_not_connected: 'datatable_forbidden',
    provider_integration_off: 'datatable_forbidden',
    nc_scope_denied: 'datatable_forbidden',
    spreadsheet_forbidden: 'datatable_forbidden',
    spreadsheet_not_found: 'datatable_not_found',
    sheet_missing: 'datatable_not_found',
    spreadsheet_conflict: 'datatable_source_rejected',
    spreadsheet_locked: 'datatable_source_rejected',
    already_linked: 'datatable_source_rejected',
    key_taken: 'datatable_source_rejected',
    key_duplicate: 'datatable_source_rejected',
    key_not_unique: 'datatable_source_rejected',
    key_missing: 'datatable_source_rejected',
    header_missing: 'datatable_source_rejected',
    spreadsheet_rejected: 'datatable_source_rejected',
    spreadsheet_write_unsupported: 'datatable_source_rejected',
    spreadsheet_too_large: 'datatable_source_rejected',
    format_unsupported: 'datatable_source_rejected',
    derived_column: 'datatable_source_rejected',
    relation_cross_scope: 'datatable_source_rejected',
    no_shared_root: 'datatable_source_rejected',
    spreadsheet_unavailable: 'datatable_source_unavailable',
    linker_unavailable: 'datatable_source_unavailable',
    nc_instance_changed: 'datatable_source_unavailable',
    rate_limited: 'datatable_source_unavailable',
});

class SpreadsheetSourceError extends SourceError {
    constructor(status, code, message, { errorClass = null, ref = null, detail = null, datatableId = null, reason = null, header = null, key = null } = {}) {
        super(status, code, message, { errorClass: errorClass || ERROR_CLASS[code] || null, ref, detail, datatableId });
        this.name = 'SpreadsheetSourceError';
        if (reason) this.reason = reason;
        if (header) this.header = header;
        if (key) this.key = key;
    }
}

const PROVIDER_NAMES = Object.freeze({ google_drive: 'Google Drive', onedrive: 'OneDrive', nextcloud_files: 'Nextcloud' });

function providerName(provider) {
    return PROVIDER_NAMES[provider] || 'the storage';
}

/**
 * Translate what a storage answered over HTTP into the refusal a Bee Flow
 * caller gets. `what` names the thing asked for ("file", "row", "sheet
 * 'Facturen'") so the sentence reads as one.
 */
function fromHttp(provider, status, text, what = 'file', { ref = null } = {}) {
    const name = providerName(provider);
    const detail = typeof text === 'string' ? text.trim().slice(0, MAX_DETAIL) : '';
    const tail = detail ? `: ${detail}` : '';
    if (status === 401) {
        return new SpreadsheetSourceError(503, 'linker_unavailable',
            `The account that linked this table can no longer sign in to ${name} — reconnect it under Settings → Connections, or ask an owner to re-link the table.`, { ref });
    }
    if (status === 403) {
        return new SpreadsheetSourceError(403, 'spreadsheet_forbidden',
            `${name} refused: the account that linked this table may not use this ${what} there.`, { ref });
    }
    if (status === 404 || status === 410) {
        return new SpreadsheetSourceError(404, 'spreadsheet_not_found',
            `${name} no longer has this ${what}.`, { ref });
    }
    if (status === 412 || status === 409) {
        return new SpreadsheetSourceError(409, 'spreadsheet_conflict',
            `The file changed in ${name} since this table was last refreshed — it is being refreshed now; try again in a moment.`, { ref });
    }
    if (status === 423) {
        return new SpreadsheetSourceError(409, 'spreadsheet_locked',
            `The file is locked in ${name} right now (someone has it open for editing). Try again in a moment.`, { ref });
    }
    if (status === 413) {
        return new SpreadsheetSourceError(413, 'spreadsheet_too_large',
            `${name} refused the upload: the file is too large.`, { ref });
    }
    if (status === 400 || status === 422) {
        return new SpreadsheetSourceError(422, 'spreadsheet_rejected',
            `${name} did not accept this ${what}${tail}`, { ref, detail });
    }
    if (status === 429 || status >= 500 || !status) {
        return new SpreadsheetSourceError(503, 'spreadsheet_unavailable',
            `${name} could not be reached (${status || 'no answer'})${tail}`, { ref });
    }
    return new SpreadsheetSourceError(502, 'spreadsheet_unavailable',
        `${name} answered ${status} for this ${what}${tail}`, { ref });
}

function isSpreadsheetSourceError(e) {
    return !!e && e.name === 'SpreadsheetSourceError';
}

module.exports = { SpreadsheetSourceError, ERROR_CLASS, fromHttp, isSpreadsheetSourceError, providerName, PROVIDER_NAMES, MAX_DETAIL };
