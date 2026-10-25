// @typecheck
/**
 * The three storages a spreadsheet mirror can read from, behind ONE shape.
 *
 * Every provider module exports the same surface —
 *   { provider, oauthProvider, integrationAppIds,
 *     isConnected({ userId, session }) → { connected, reason },
 *     forCaller(cred, ctx) → FileApi, forLinker(cred, ctx) → FileApi }
 * — and a FileApi is the same set of verbs whichever storage answers:
 *   list({ view, parentId|path, q, pageToken }) → { items: FileRef[], nextPageToken }
 *   probe(file)                → { marker, name, size, mimeType, format, path, webUrl, owned, writable, file }
 *   download(file, { maxBytes }) → { buffer, marker }
 *   upload(file, buffer, { ifMatch, contentType }) → { marker }
 *   markerEquals(a, b)
 *   cells?  — a cell-precise API where the storage has one (Google Sheets,
 *             Excel in OneDrive through the Graph workbook API); absent on
 *             Nextcloud, where a change is a download and a write is a PUT.
 * A FileRef is { provider, fileId, driveId?, path?, name, mimeType, format|null,
 * size, modifiedAt, etag|null, webUrl, parentId, isFolder, owned }.
 *
 * The engine (sync, describe, write-through) never sees a Drive client, a
 * Graph URL or a WebDAV body; it sees FileRefs, markers and Buffers. Modules
 * are required lazily so loading the registry loads none of the three SDK
 * paths — a Nextcloud-only test suite never touches googleapis.
 */

'use strict';

const { PROVIDERS } = require('../index');

/** Storage MIME type → format. Google's native Sheet has no extension. */
const SPREADSHEET_MIMES = Object.freeze({
    'application/vnd.google-apps.spreadsheet': 'gsheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel.sheet.macroEnabled.12': 'xlsm',
    'application/vnd.ms-excel': 'xls',
    'text/csv': 'csv',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
});

const EXT_TO_FORMAT = Object.freeze({ xlsx: 'xlsx', xlsm: 'xlsm', xls: 'xls', csv: 'csv', ods: 'ods' });

const MODULES = Object.freeze({
    google_drive: './googleDrive',
    onedrive: './oneDrive',
    nextcloud_files: './nextcloudFiles',
});

/**
 * The format a file is, from what a listing tells us. The extension wins
 * over the MIME type: storages type an uploaded `.csv` as text/plain and an
 * `.xlsx` as application/octet-stream often enough that the MIME alone would
 * hide real spreadsheets; the MIME is what identifies a native Google Sheet.
 * @param {{ name?:string, mimeType?:string }} [file]
 * @returns {string|null} one of FORMATS, or null for anything else
 */
function formatOf({ name, mimeType } = {}) {
    const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    if (ext && EXT_TO_FORMAT[ext[1]]) return EXT_TO_FORMAT[ext[1]];
    if (mimeType && SPREADSHEET_MIMES[mimeType]) return SPREADSHEET_MIMES[mimeType];
    return null;
}

/** Is this a file name the browser should show? (Folders are decided elsewhere.) */
function isSpreadsheetName(name) {
    return formatOf({ name }) !== null;
}

/**
 * @param {string} name  one of PROVIDERS
 * @returns {object} the provider module
 * @throws {Error} for a name outside PROVIDERS (a programming error, not a user one)
 */
function providerFor(name) {
    const request = MODULES[name];
    if (!request) {
        const e = new Error(`Unknown spreadsheet provider: ${String(name).slice(0, 40)}`);
        e.code = 'unknown_provider';
        throw e;
    }
    return require(request);
}

module.exports = { providerFor, formatOf, isSpreadsheetName, SPREADSHEET_MIMES, EXT_TO_FORMAT, PROVIDERS };

/** @typedef {{ provider?: string, fileId?: string, id?: string, driveId?: string|null, path?: string|null, name?: string|null, owned?: boolean, writable?: boolean, size?: number, mimeType?: string, format?: string|null, webUrl?: string, [k: string]: unknown }} FileRef */

/** @typedef {{ marker?: { modified?: string, modifiedTime?: string, lastModifiedDateTime?: string }, name?: string, size?: number, mimeType?: string, format?: string|null, path?: string, webUrl?: string, owned?: boolean, writable?: boolean, file: FileRef }} FileProbe */

/**
 * The cell-precise half of a FileApi (Google Sheets, Excel through Graph).
 * @typedef {{ available?: (file: FileRef) => Promise<boolean>,
 *             listSheets: (file: FileRef) => Promise<Array<{ id?: string, name?: string, index?: number, rowCount?: number, colCount?: number, hidden?: boolean }>>,
 *             readSheet: (file: FileRef, tab: string, opts: object) => Promise<{ rows: Array<Array<unknown>>, errorCells?: number }>,
 *             sample: (file: FileRef, tab: string, opts: object) => Promise<{ numberFormat?: Map<number, string>, formulaCols?: Set<number> }> }} FileCells
 */

/**
 * The verbs a storage answers (see the header).
 * @typedef {{ probe: (file: FileRef) => Promise<FileProbe>,
 *             download: (file: FileRef, opts?: { maxBytes?: number }) => Promise<{ buffer: Buffer, marker?: object }>,
 *             markerEquals: (a: object, b: object) => boolean,
 *             cells?: FileCells,
 *             list?: (opts: { view: string, parentId?: unknown, path?: string, q?: string|null, pageToken?: string|null }) => Promise<{ items?: FileRef[], nextPageToken?: string|null }>,
 *             [verb: string]: unknown }} FileApi
 */

/**
 * The surface every provider module exports (see the header).
 * @typedef {{ provider: string, oauthProvider: string, integrationAppIds: string[],
 *             isConnected: (opts?: { userId?: string, session?: object|null }) => Promise<{ connected: boolean, reason: string|null }>,
 *             forCaller: (cred: object, ctx?: object) => FileApi,
 *             forLinker: (cred: object, ctx?: object) => FileApi,
 *             markerEquals: (a: object, b: object) => boolean }} ProviderModule
 */
