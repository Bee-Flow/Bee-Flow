// @typecheck noImplicitAny
/**
 * Google Drive / Sheets vocabulary for ./googleDrive.js and
 * ./googleSheetsCells.js: the field lists, the Drive query quoting, the
 * file-resource -> FileRef mapping, the change marker, the error translation
 * and the cell value codecs (UNFORMATTED_VALUE in, typed ExtendedValue out).
 * Pure: no client, no I/O.
 */

'use strict';

const { SpreadsheetSourceError, fromHttp } = require('../errors');
const { formatOf } = require('./index');

/** @typedef {import('./index').FileRef} FileRef */
/** @typedef {import('./index').FileProbe} FileProbe */
/**
 * A Drive v3 file resource, the FILE_FIELDS of it (the googleapis typings are
 * shimmed out of the typecheck, see types/shims/googleapis.d.ts).
 * @typedef {{ id?: string, name?: string, mimeType?: string, size?: string|number, modifiedTime?: string,
 *             version?: string|number, md5Checksum?: string, webViewLink?: string, parents?: string[], driveId?: string,
 *             shortcutDetails?: { targetId?: string, targetMimeType?: string }, ownedByMe?: boolean,
 *             capabilities?: { canEdit?: boolean }, trashed?: boolean }} DriveFile
 */
/**
 * A Sheets v4 CellData, the fields sampled with includeGridData.
 * @typedef {{ effectiveValue?: { numberValue?: number, stringValue?: string, boolValue?: boolean },
 *             effectiveFormat?: { numberFormat?: { type?: string } }, userEnteredValue?: { formulaValue?: string } }} SheetCellData
 */
/**
 * The Drive v3 + Sheets v4 calls this provider makes.
 * @typedef {{
 *   drive: { files: {
 *     list: (params: object) => Promise<{ data: { files?: DriveFile[], nextPageToken?: string } }>,
 *     get: { (params: { alt: 'media', [k: string]: unknown }, opts: { responseType: string }): Promise<{ data: unknown }>; (params: object): Promise<{ data: DriveFile }> },
 *     update: (params: object) => Promise<{ data: DriveFile }> } },
 *   sheets: { spreadsheets: {
 *     get: (params: object) => Promise<{ data: { sheets?: Array<{
 *       properties?: { sheetId?: number, title?: string, index?: number, hidden?: boolean, gridProperties?: { rowCount?: number, columnCount?: number } },
 *       data?: Array<{ rowData?: Array<{ values?: SheetCellData[] }> }> }> } }>,
 *     batchUpdate: (params: object) => Promise<{ data: unknown }>,
 *     values: {
 *       get: (params: object) => Promise<{ data: { values?: unknown[][] } }>,
 *       append: (params: object) => Promise<{ data: { updates?: { updatedRange?: string } } }> } } }
 * }} GoogleClients
 */
/** @typedef {{ version: string|null, modifiedTime: string|null, md5Checksum: string|null, size: number|null }} DriveMarker */
/**
 * The drive context makeApi builds and every function in ./googleDrive.js
 * and ./googleSheetsCells.js takes.
 * @typedef {{ clients: () => Promise<GoogleClients>, idOf: (file: FileRef) => string,
 *             probe?: (file: FileRef) => Promise<FileProbe & { marker: DriveMarker }>,
 *             guard?: (file: FileRef, ifMatch: DriveMarker|null) => Promise<FileProbe & { marker: DriveMarker }> }} DriveCtx
 */
/** A tab: its name, or a listSheets entry. @typedef {string | { id?: number, gid?: number, name?: string }} SheetArg */
/** A googleapis failure, as much of it as translate reads. @typedef {{ code?: number, status?: number, response?: { status?: number }, errors?: Array<{ message?: string }>, message?: string }} GoogleError */

const provider = 'google_drive';
const oauthProvider = 'google';
const integrationAppIds = ['google-drive'];

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const PAGE_SIZE = 50;

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,version,md5Checksum,webViewLink,parents,driveId,shortcutDetails,ownedByMe,capabilities(canEdit),trashed';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

/** Sheets answers a formula error as its display string under UNFORMATTED_VALUE. */
const ERROR_STRINGS = new Set(['#N/A', '#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#NUM!', '#NULL!', '#ERROR!']);

// ─── Small helpers ──────────────────────────────────────────────────────

/**
 * Drive query strings quote with single quotes and escape with a backslash.
 * @param {unknown} s
 */
function escapeQ(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * A tab name inside an A1 range: quoted, embedded quotes doubled.
 * @param {unknown} name
 */
function quoteTab(name) {
    return `'${String(name).replace(/'/g, "''")}'`;
}

/**
 * 0-based column → letter(s): 0 → A, 25 → Z, 26 → AA.
 * @param {number|string} col
 */
function colLetter(col) {
    let n = Number(col) + 1;
    let s = '';
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/** @param {GoogleError} err */
function statusOf(err) {
    if (!err) return 0;
    if (Number.isInteger(err.code)) return err.code;
    if (Number.isInteger(err.status)) return err.status;
    if (err.response && Number.isInteger(err.response.status)) return err.response.status;
    return 0;
}

/** @param {GoogleError} err */
function messageOf(err) {
    const first = err && err.errors && err.errors[0] && err.errors[0].message;
    return first || (err && err.message) || '';
}

/** @param {FileRef} file */
function refOf(file) {
    return { provider, fileId: file && (file.fileId || file.id) || null };
}

/**
 * Translate a googleapis failure into the mirror's refusal.
 * @param {GoogleError} err
 * @param {string} what
 * @param {FileRef} file
 * @param {SheetArg} [sheet]
 */
function translate(err, what, file, sheet) {
    if (err instanceof SpreadsheetSourceError) return err;
    const status = statusOf(err);
    const msg = messageOf(err);
    const ref = { ...refOf(file), ...(sheet ? { sheet: typeof sheet === 'string' ? sheet : sheet.name } : {}) };
    // Sheets says this, with a 400, when the tab in the range does not exist.
    if (status === 400 && /Unable to parse range/i.test(msg)) {
        return new SpreadsheetSourceError(404, 'sheet_missing', `The sheet ${ref.sheet ? `'${ref.sheet}' ` : ''}no longer exists in this Google Sheet.`, { ref });
    }
    return fromHttp(provider, status, msg, what, { ref });
}

/**
 * @param {DriveFile} f
 * @returns {DriveMarker}
 */
function markerOf(f) {
    return {
        version: f.version != null ? String(f.version) : null,
        modifiedTime: f.modifiedTime || null,
        md5Checksum: f.md5Checksum || null,
        size: f.size != null ? Number(f.size) : null,
    };
}

/**
 * @param {{ version?: unknown }} a
 * @param {{ version?: unknown }} b
 */
function markerEquals(a, b) {
    return !!a && !!b && a.version != null && String(a.version) === String(b.version);
}

/**
 * A Drive file resource → FileRef. A shortcut becomes a ref to its TARGET
 * (the id the engine will probe and read); a shortcut to something that is
 * neither a folder nor a spreadsheet is dropped.
 * @param {DriveFile} f
 * @param {{ parentId?: string|null }} [opts]
 * @returns {FileRef|null}
 */
function toFileRef(f, { parentId = null } = {}) {
    if (!f || !f.id) return null;
    let id = f.id;
    let mimeType = f.mimeType || null;
    let shortcut = false;
    if (mimeType === SHORTCUT_MIME) {
        const t = f.shortcutDetails || {};
        if (!t.targetId) return null;
        id = t.targetId;
        mimeType = t.targetMimeType || null;
        shortcut = true;
    }
    const isFolder = mimeType === FOLDER_MIME;
    const format = isFolder ? null : formatOf({ name: f.name, mimeType });
    if (!isFolder && !format) return null;
    return {
        provider,
        fileId: id,
        driveId: f.driveId || null,
        path: null,
        name: f.name || '',
        mimeType,
        format,
        size: f.size != null ? Number(f.size) : null,
        modifiedAt: f.modifiedTime || null,
        etag: null,
        webUrl: f.webViewLink || null,
        parentId: (Array.isArray(f.parents) && f.parents[0]) || parentId || null,
        isFolder,
        owned: f.ownedByMe === true,
        writable: !(f.capabilities && f.capabilities.canEdit === false),
        ...(shortcut ? { shortcut: true, shortcutId: f.id } : {}),
    };
}

/**
 * The value Sheets shows for a cell, as UNFORMATTED_VALUE hands it over.
 * @param {unknown} v
 */
function readCell(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && ERROR_STRINGS.has(v)) return null;
    return v;
}

/**
 * includeGridData cell → { value, numberFormatType, formula }.
 * @param {SheetCellData} c
 */
function gridCell(c) {
    const ev = (c && c.effectiveValue) || null;
    let value = null;
    if (ev) {
        if (ev.numberValue !== undefined) value = ev.numberValue;
        else if (ev.stringValue !== undefined) value = ev.stringValue;
        else if (ev.boolValue !== undefined) value = ev.boolValue;
        else value = null;  // errorValue
    }
    const nf = c && c.effectiveFormat && c.effectiveFormat.numberFormat && c.effectiveFormat.numberFormat.type;
    const formula = !!(c && c.userEnteredValue && c.userEnteredValue.formulaValue);
    return { value, numberFormatType: nf || null, formula };
}

/**
 * The typed value a cell is WRITTEN as. `type` is the column's declared
 * type; dates arrive as serial numbers already. Empty → `{}`, which with the
 * `userEnteredValue` field mask clears the cell and keeps its format.
 * @param {unknown} value
 * @param {string} type
 * @returns {{ numberValue?: number, stringValue?: string, boolValue?: boolean }}
 */
function extendedValue(value, type) {
    if (value === null || value === undefined || value === '') return {};
    switch (type) {
        case 'number':
        case 'date':
        case 'datetime': {
            const n = Number(value);
            return Number.isFinite(n) ? { numberValue: n } : { stringValue: String(value) };
        }
        case 'bool':
            return { boolValue: value === true || value === 'true' || value === 1 };
        default:
            return { stringValue: String(value) };
    }
}

/**
 * The same value for values.append under RAW (JSON keeps the type).
 * @param {unknown} value
 * @param {string} type
 */
function rawValue(value, type) {
    if (value === null || value === undefined || value === '') return null;
    const ev = extendedValue(value, type);
    if (ev.numberValue !== undefined) return ev.numberValue;
    if (ev.boolValue !== undefined) return ev.boolValue;
    return ev.stringValue;
}

/** @param {string|null|undefined} range */
function rowNumberOfRange(range) {
    const m = /!\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?$/.exec(String(range || ''));
    return m ? Number(m[1]) : null;
}

module.exports = {
    provider, oauthProvider, integrationAppIds,
    FOLDER_MIME, SHORTCUT_MIME, PAGE_SIZE, FILE_FIELDS, LIST_FIELDS, ERROR_STRINGS,
    escapeQ, quoteTab, colLetter, refOf, translate, markerOf, markerEquals, toFileRef,
    readCell, gridCell, extendedValue, rawValue, rowNumberOfRange,
};
