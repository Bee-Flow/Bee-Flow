// @typecheck noImplicitAny
/**
 * Google Drive (+ native Google Sheets) as a spreadsheet-mirror storage.
 *
 * One OAuth2 client serves Drive v3 (listing, the change marker, bytes of an
 * uploaded xlsx/csv/ods) and Sheets v4 (cells of a native Sheet), built the
 * way integrations/sheetsTools.js builds its client. Two facts shape the
 * code:
 *   • Drive's `version` is the only monotonic change counter, and it ALSO
 *     moves on a rename, a share, a star or a comment — so it is the cheap
 *     "same file?" answer and the engine still hashes the content after a
 *     download. There is no If-Match anywhere in Drive v3 or Sheets v4: the
 *     write guard is EMULATED — probe before, refuse when `version` moved,
 *     probe after for the new marker. Two edits of one row inside that
 *     window can still last-write-win; the engine's row verification is what
 *     narrows it.
 *   • A native Sheet has no bytes. It is read with values.get UNFORMATTED_VALUE
 *     + SERIAL_NUMBER (numbers, booleans, dates-as-serials, text — one
 *     compact call) and sampled once with includeGridData for number formats
 *     and formulas; writes go through batchUpdate with a TYPED ExtendedValue
 *     and `fields: 'userEnteredValue'`, which keeps the cell's own number
 *     format (a date column stays a date column) and never lets a string be
 *     parsed as a formula or a phone number.
 * Dates cross this boundary as Excel/Sheets SERIAL NUMBERS (epoch
 * 1899-12-30) in both directions; the engine's codec turns them into ISO.
 *
 * Shared-with-me files are listed and readable; `owned` (ownedByMe) is what
 * the engine uses to refuse writing rows into someone else's storage.
 *
 * The vocabulary (fields, quoting, FileRef mapping, value codecs) is in
 * ./googleDriveFormat.js; the native-Sheet cell access in ./googleSheetsCells.js.
 */

'use strict';

const { Readable } = require('stream');
const { SpreadsheetSourceError } = require('../errors');
const { SPREADSHEET_MIMES } = require('./index');
// The Google client is injected by integrations/ (core/integrations/integrationClients.js).
const { integrationClient } = require('../../../../integrations/integrationClients');
const format = require('./googleDriveFormat');
const { makeSheetCells } = require('./googleSheetsCells');

/** @typedef {import('./googleDriveFormat').DriveCtx} DriveCtx */
/** @typedef {import('./googleDriveFormat').DriveMarker} DriveMarker */
/** @typedef {import('./index').FileRef} FileRef */

const {
    provider, oauthProvider, integrationAppIds,
    FOLDER_MIME, SHORTCUT_MIME, PAGE_SIZE, FILE_FIELDS, LIST_FIELDS,
    escapeQ, refOf, translate, markerOf, markerEquals, toFileRef,
} = format;

// ─── The FileApi ────────────────────────────────────────────────────────
//
// Every function below takes the drive context `d` makeApi builds:
//   { clients(), idOf(file), probe(file), guard(file, ifMatch) }

/**
 * The Drive + Sheets clients for one credential, built once on first use.
 * @param {{ save?: () => unknown }} cred
 * @returns {() => Promise<import('./googleDriveFormat').GoogleClients>}
 */
function makeClients(cred) {
    /** @type {Promise<import('./googleDriveFormat').GoogleClients>|null} */
    let clientsPromise = null;
    return () => {
        if (!clientsPromise) {
            const { createGoogleApiClient } = integrationClient('google');
            clientsPromise = createGoogleApiClient(cred, {
                api: 'drive', version: 'v3',
                extraApis: [{ api: 'sheets', version: 'v4' }],
                // Rotated tokens go back into the vault through the shim.
                onSaved: typeof cred.save === 'function' ? () => cred.save() : undefined,
                notConnectedError: 'provider_not_connected',
            }).catch((/** @type {Error} */ e) => {
                clientsPromise = null;
                if (e && e.message === 'provider_not_connected') {
                    throw new SpreadsheetSourceError(403, 'provider_not_connected',
                        'The account that linked this table is not connected to Google Drive — reconnect it under Settings → Connections.');
                }
                // "Google OAuth not configured": an install without a Google
                // client — the storage is unreachable, not the file.
                throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', `Google Drive cannot be reached from this server: ${String(e && e.message || e).slice(0, 120)}`);
            });
        }
        return clientsPromise;
    };
}

/** @param {FileRef} file */
function idOf(file) {
    const id = file && (file.fileId || file.id);
    if (!id) throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A Google Drive file needs an id.');
    return id;
}

/**
 * The Drive query and ordering a listing view asks for; null for a search without a term.
 * @param {{ view: string, parentId: string|null, q: string|null }} opts
 */
function listQuery({ view, parentId, q }) {
    const FOLDER = `mimeType='${FOLDER_MIME}'`;
    const SPREAD = `(${[...Object.keys(SPREADSHEET_MIMES), SHORTCUT_MIME].map((m) => `mimeType='${m}'`).join(' or ')})`;
    if (view === 'search') {
        const term = String(q || '').trim();
        if (!term) return null;
        return { query: `name contains '${escapeQ(term)}' and trashed=false and ${SPREAD}`, orderBy: 'folder,name' };
    }
    if (view === 'recent') return { query: `${SPREAD} and trashed=false`, orderBy: 'modifiedTime desc' };
    if (view === 'shared' && !parentId) {
        return { query: `sharedWithMe=true and trashed=false and (${FOLDER} or ${SPREAD})`, orderBy: 'folder,name' };
    }
    return { query: `'${escapeQ(parentId || 'root')}' in parents and trashed=false and (${FOLDER} or ${SPREAD})`, orderBy: 'folder,name' };
}

/**
 * @param {DriveCtx} d
 * @param {{ view?: string, parentId?: string|null, q?: string|null, pageToken?: string|null }} [opts]
 */
async function list(d, { view = 'mine', parentId = null, q = null, pageToken = null } = {}) {
    const { drive } = await d.clients();
    const asked = listQuery({ view, parentId, q });
    if (!asked) return { items: [], nextPageToken: null };
    let res;
    try {
        res = await drive.files.list({
            q: asked.query,
            pageSize: PAGE_SIZE,
            pageToken: pageToken || undefined,
            orderBy: asked.orderBy,
            fields: LIST_FIELDS,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
    } catch (e) {
        throw translate(e, 'folder', { fileId: parentId });
    }
    const items = (res.data.files || []).map((f) => toFileRef(f, { parentId })).filter(Boolean);
    return { items, nextPageToken: res.data.nextPageToken || null };
}

/**
 * @param {DriveCtx} d
 * @param {FileRef} file
 */
async function probe(d, file) {
    const fileId = d.idOf(file);
    const { drive } = await d.clients();
    let f;
    try {
        f = (await drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true })).data;
    } catch (e) {
        throw translate(e, 'file', file);
    }
    if (!f || f.trashed) {
        throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', 'Google Drive no longer has this file (it is in the bin or gone).', { ref: refOf(file) });
    }
    const ref = /** @type {import('./index').FileRef} */ (toFileRef(f));
    if (!ref) {
        throw new SpreadsheetSourceError(415, 'format_unsupported', `"${f.name}" is not a spreadsheet Bee Flow can read.`, { ref: refOf(file) });
    }
    return {
        marker: markerOf(f),
        name: ref.name,
        size: ref.size,
        mimeType: ref.mimeType,
        format: ref.format,
        path: /** @type {string|null} */ (null),
        webUrl: ref.webUrl,
        owned: ref.owned,
        writable: ref.writable,
        file: ref,
    };
}

/**
 * What a stubbed or real gaxios client hands back for responseType 'arraybuffer', as a Buffer.
 * @param {unknown} data
 */
function toBuffer(data) {
    return Buffer.isBuffer(data) ? data
        : data instanceof ArrayBuffer ? Buffer.from(data)
            : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
                : Buffer.from(String(data ?? ''));
}

/**
 * @param {DriveCtx} d
 * @param {FileRef} file
 * @param {{ maxBytes?: number|null }} [opts]
 */
async function download(d, file, { maxBytes = null } = {}) {
    const p = await d.probe(file);
    if (p.format === 'gsheet') {
        throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A native Google Sheet has no file to download — it is read through the Sheets API.', { ref: refOf(file) });
    }
    if (maxBytes && p.size != null && p.size > maxBytes) {
        throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is ${Math.round(p.size / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB.`, { ref: refOf(file) });
    }
    const { drive } = await d.clients();
    let res;
    try {
        res = await drive.files.get({ fileId: d.idOf(file), alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    } catch (e) {
        throw translate(e, 'file', file);
    }
    // gaxios answers an ArrayBuffer for responseType 'arraybuffer'; a
    // stubbed client may hand a Buffer, a view or a string.
    const buffer = toBuffer(res.data);
    if (maxBytes && buffer.length > maxBytes) {
        throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is larger than ${Math.round(maxBytes / 1048576)} MB.`, { ref: refOf(file) });
    }
    // The marker is the one probed BEFORE the bytes: a change in between
    // makes the next probe say "moved" and costs one redundant download,
    // never a missed change.
    return { buffer, marker: p.marker };
}

/**
 * The emulated guard: refuse when the file moved past `ifMatch`.
 * @param {DriveCtx} d
 * @param {FileRef} file
 * @param {DriveMarker|null} ifMatch
 */
async function guard(d, file, ifMatch) {
    const p = await d.probe(file);
    if (ifMatch && !markerEquals(p.marker, ifMatch)) {
        throw new SpreadsheetSourceError(409, 'spreadsheet_conflict',
            'The file changed in Google Drive since this table was last refreshed — it is being refreshed now; try again in a moment.', { ref: refOf(file) });
    }
    return p;
}

/**
 * @param {DriveCtx} d
 * @param {FileRef} file
 * @param {Buffer} buffer
 * @param {{ ifMatch?: DriveMarker|null, contentType?: string|null }} [opts]
 */
async function upload(d, file, buffer, { ifMatch = null, contentType = null } = {}) {
    const p = await d.guard(file, ifMatch);
    const { drive } = await d.clients();
    let res;
    try {
        res = await drive.files.update({
            fileId: d.idOf(file),
            media: { mimeType: contentType || p.mimeType || 'application/octet-stream', body: Readable.from(buffer) },
            fields: 'id,name,version,modifiedTime,md5Checksum,size',
            supportsAllDrives: true,
        });
    } catch (e) {
        throw translate(e, 'file', file);
    }
    return { marker: markerOf(res.data) };
}

/**
 * @param {{ save?: () => unknown }} cred
 * @param {object} [ctx]
 */
function makeApi(cred, ctx = {}) {
    void ctx;
    /** @type {DriveCtx} */
    const d = { clients: makeClients(cred), idOf };
    d.probe = (file) => probe(d, file);
    d.guard = (file, ifMatch) => guard(d, file, ifMatch);
    return {
        provider,
        /** @param {Parameters<typeof list>[1]} [opts] */
        list: (opts) => list(d, opts),
        probe: d.probe,
        /** @param {FileRef} file @param {Parameters<typeof download>[2]} [opts] */
        download: (file, opts) => download(d, file, opts),
        /** @param {FileRef} file @param {Buffer} buffer @param {Parameters<typeof upload>[3]} [opts] */
        upload: (file, buffer, opts) => upload(d, file, buffer, opts),
        markerEquals,
        cells: makeSheetCells(d),
    };
}

/**
 * Cheap: a vault row or session tokens for Google — no provider call.
 * @param {{ userId?: string, session?: object|null }} [opts]
 */
async function isConnected({ userId, session = null } = {}) {
    return require('../credentials').cheapStatus(userId, oauthProvider, { session });
}

module.exports = {
    provider, oauthProvider, integrationAppIds,
    isConnected,
    forCaller: makeApi,
    forLinker: makeApi,
    markerEquals,
    // exported for tests
    toFileRef: format.toFileRef, extendedValue: format.extendedValue, rawValue: format.rawValue,
    colLetter: format.colLetter, quoteTab: format.quoteTab, escapeQ, rowNumberOfRange: format.rowNumberOfRange, FILE_FIELDS,
};
