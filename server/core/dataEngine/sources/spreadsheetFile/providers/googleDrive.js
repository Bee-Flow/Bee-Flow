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
 */

'use strict';

const { Readable } = require('stream');
const { SpreadsheetSourceError, fromHttp } = require('../errors');
const { formatOf, SPREADSHEET_MIMES } = require('./index');

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

/** Drive query strings quote with single quotes and escape with a backslash. */
function escapeQ(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** A tab name inside an A1 range: quoted, embedded quotes doubled. */
function quoteTab(name) {
    return `'${String(name).replace(/'/g, "''")}'`;
}

/** 0-based column → letter(s): 0 → A, 25 → Z, 26 → AA. */
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

function statusOf(err) {
    if (!err) return 0;
    if (Number.isInteger(err.code)) return err.code;
    if (Number.isInteger(err.status)) return err.status;
    if (err.response && Number.isInteger(err.response.status)) return err.response.status;
    return 0;
}

function messageOf(err) {
    const first = err && err.errors && err.errors[0] && err.errors[0].message;
    return first || (err && err.message) || '';
}

function refOf(file) {
    return { provider, fileId: file && (file.fileId || file.id) || null };
}

/** Translate a googleapis failure into the mirror's refusal. */
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

function markerOf(f) {
    return {
        version: f.version != null ? String(f.version) : null,
        modifiedTime: f.modifiedTime || null,
        md5Checksum: f.md5Checksum || null,
        size: f.size != null ? Number(f.size) : null,
    };
}

function markerEquals(a, b) {
    return !!a && !!b && a.version != null && String(a.version) === String(b.version);
}

/**
 * A Drive file resource → FileRef. A shortcut becomes a ref to its TARGET
 * (the id the engine will probe and read); a shortcut to something that is
 * neither a folder nor a spreadsheet is dropped.
 * @returns {object|null}
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

/** The value Sheets shows for a cell, as UNFORMATTED_VALUE hands it over. */
function readCell(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && ERROR_STRINGS.has(v)) return null;
    return v;
}

/** includeGridData cell → { value, numberFormatType, formula }. */
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

/** The same value for values.append under RAW (JSON keeps the type). */
function rawValue(value, type) {
    if (value === null || value === undefined || value === '') return null;
    const ev = extendedValue(value, type);
    if (ev.numberValue !== undefined) return ev.numberValue;
    if (ev.boolValue !== undefined) return ev.boolValue;
    return ev.stringValue;
}

function rowNumberOfRange(range) {
    const m = /!\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?$/.exec(String(range || ''));
    return m ? Number(m[1]) : null;
}

// ─── The FileApi ────────────────────────────────────────────────────────

function makeApi(cred, ctx = {}) {
    void ctx;
    let clientsPromise = null;
    const clients = () => {
        if (!clientsPromise) {
            const { createGoogleApiClient } = require('../../../../../integrations/googleClient');
            clientsPromise = createGoogleApiClient(cred, {
                api: 'drive', version: 'v3',
                extraApis: [{ api: 'sheets', version: 'v4' }],
                // Rotated tokens go back into the vault through the shim.
                onSaved: typeof cred.save === 'function' ? () => cred.save() : undefined,
                notConnectedError: 'provider_not_connected',
            }).catch((e) => {
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
    const idOf = (file) => {
        const id = file && (file.fileId || file.id);
        if (!id) throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A Google Drive file needs an id.');
        return id;
    };

    async function list({ view = 'mine', parentId = null, q = null, pageToken = null } = {}) {
        const { drive } = await clients();
        const FOLDER = `mimeType='${FOLDER_MIME}'`;
        const SPREAD = `(${[...Object.keys(SPREADSHEET_MIMES), SHORTCUT_MIME].map((m) => `mimeType='${m}'`).join(' or ')})`;
        let query;
        let orderBy = 'folder,name';
        if (view === 'search') {
            const term = String(q || '').trim();
            if (!term) return { items: [], nextPageToken: null };
            query = `name contains '${escapeQ(term)}' and trashed=false and ${SPREAD}`;
        } else if (view === 'recent') {
            query = `${SPREAD} and trashed=false`;
            orderBy = 'modifiedTime desc';
        } else if (view === 'shared' && !parentId) {
            query = `sharedWithMe=true and trashed=false and (${FOLDER} or ${SPREAD})`;
        } else {
            query = `'${escapeQ(parentId || 'root')}' in parents and trashed=false and (${FOLDER} or ${SPREAD})`;
        }
        let res;
        try {
            res = await drive.files.list({
                q: query,
                pageSize: PAGE_SIZE,
                pageToken: pageToken || undefined,
                orderBy,
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

    async function probe(file) {
        const fileId = idOf(file);
        const { drive } = await clients();
        let f;
        try {
            f = (await drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true })).data;
        } catch (e) {
            throw translate(e, 'file', file);
        }
        if (!f || f.trashed) {
            throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', 'Google Drive no longer has this file (it is in the bin or gone).', { ref: refOf(file) });
        }
        const ref = toFileRef(f);
        if (!ref) {
            throw new SpreadsheetSourceError(415, 'format_unsupported', `"${f.name}" is not a spreadsheet Bee Flow can read.`, { ref: refOf(file) });
        }
        return {
            marker: markerOf(f),
            name: ref.name,
            size: ref.size,
            mimeType: ref.mimeType,
            format: ref.format,
            path: null,
            webUrl: ref.webUrl,
            owned: ref.owned,
            writable: ref.writable,
            file: ref,
        };
    }

    async function download(file, { maxBytes = null } = {}) {
        const p = await probe(file);
        if (p.format === 'gsheet') {
            throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A native Google Sheet has no file to download — it is read through the Sheets API.', { ref: refOf(file) });
        }
        if (maxBytes && p.size != null && p.size > maxBytes) {
            throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is ${Math.round(p.size / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB.`, { ref: refOf(file) });
        }
        const { drive } = await clients();
        let res;
        try {
            res = await drive.files.get({ fileId: idOf(file), alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
        } catch (e) {
            throw translate(e, 'file', file);
        }
        const data = res.data;
        // gaxios answers an ArrayBuffer for responseType 'arraybuffer'; a
        // stubbed client may hand a Buffer, a view or a string.
        const buffer = Buffer.isBuffer(data) ? data
            : data instanceof ArrayBuffer ? Buffer.from(data)
                : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
                    : Buffer.from(String(data ?? ''));
        if (maxBytes && buffer.length > maxBytes) {
            throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is larger than ${Math.round(maxBytes / 1048576)} MB.`, { ref: refOf(file) });
        }
        // The marker is the one probed BEFORE the bytes: a change in between
        // makes the next probe say "moved" and costs one redundant download,
        // never a missed change.
        return { buffer, marker: p.marker };
    }

    /** The emulated guard: refuse when the file moved past `ifMatch`. */
    async function guard(file, ifMatch) {
        const p = await probe(file);
        if (ifMatch && !markerEquals(p.marker, ifMatch)) {
            throw new SpreadsheetSourceError(409, 'spreadsheet_conflict',
                'The file changed in Google Drive since this table was last refreshed — it is being refreshed now; try again in a moment.', { ref: refOf(file) });
        }
        return p;
    }

    async function upload(file, buffer, { ifMatch = null, contentType = null } = {}) {
        const p = await guard(file, ifMatch);
        const { drive } = await clients();
        let res;
        try {
            res = await drive.files.update({
                fileId: idOf(file),
                media: { mimeType: contentType || p.mimeType || 'application/octet-stream', body: Readable.from(buffer) },
                fields: 'id,name,version,modifiedTime,md5Checksum,size',
                supportsAllDrives: true,
            });
        } catch (e) {
            throw translate(e, 'file', file);
        }
        return { marker: markerOf(res.data) };
    }

    // ── cells: native Google Sheets ──────────────────────────────────

    const sheetName = (sheet) => (typeof sheet === 'string' ? sheet : (sheet && sheet.name) || '');

    async function listSheets(file) {
        const { sheets } = await clients();
        let res;
        try {
            res = await sheets.spreadsheets.get({
                spreadsheetId: idOf(file),
                fields: 'sheets.properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount))',
            });
        } catch (e) {
            throw translate(e, 'spreadsheet', file);
        }
        return (res.data.sheets || []).map((s) => {
            const p = s.properties || {};
            return {
                id: p.sheetId != null ? p.sheetId : null,
                name: p.title || '',
                index: p.index || 0,
                rowCount: p.gridProperties && p.gridProperties.rowCount != null ? p.gridProperties.rowCount : null,
                colCount: p.gridProperties && p.gridProperties.columnCount != null ? p.gridProperties.columnCount : null,
                hidden: !!p.hidden,
            };
        });
    }

    /** The gid a write needs; a sheet given by name alone costs one lookup. */
    async function gidOf(file, sheet) {
        if (sheet && typeof sheet === 'object' && sheet.id != null) return sheet.id;
        if (sheet && typeof sheet === 'object' && sheet.gid != null) return sheet.gid;
        const name = sheetName(sheet);
        const found = (await listSheets(file)).find((s) => s.name === name);
        if (!found) {
            throw new SpreadsheetSourceError(404, 'sheet_missing', `The sheet '${name}' no longer exists in this Google Sheet.`, { ref: { ...refOf(file), sheet: name } });
        }
        return found.id;
    }

    async function sample(file, sheet, { headerRow = 1, rows = 500 } = {}) {
        const { sheets } = await clients();
        const tab = sheetName(sheet);
        let res;
        try {
            res = await sheets.spreadsheets.get({
                spreadsheetId: idOf(file),
                includeGridData: true,
                ranges: [`${quoteTab(tab)}!1:${headerRow + rows}`],
                fields: 'sheets.data.rowData.values(effectiveValue,effectiveFormat.numberFormat.type,userEnteredValue.formulaValue)',
            });
        } catch (e) {
            throw translate(e, `sheet '${tab}'`, file, tab);
        }
        const rowData = (((res.data.sheets || [])[0] || {}).data || [])[0];
        const grid = (rowData && rowData.rowData) || [];
        const matrix = [];
        const formatTally = new Map();   // col → { DATE:n, DATE_TIME:n, TIME:n }
        const formulaCols = new Set();
        grid.forEach((r, ri) => {
            const cells = (r && r.values) || [];
            const row = [];
            cells.forEach((c, ci) => {
                const g = gridCell(c);
                row.push(g.value);
                if (ri < headerRow) return;   // header and above: no type evidence
                if (g.formula) formulaCols.add(ci);
                if (g.numberFormatType && /^(DATE|DATE_TIME|TIME)$/.test(g.numberFormatType) && g.value !== null) {
                    const t = formatTally.get(ci) || {};
                    t[g.numberFormatType] = (t[g.numberFormatType] || 0) + 1;
                    formatTally.set(ci, t);
                }
            });
            matrix.push(row);
        });
        const numberFormat = new Map();
        for (const [col, t] of formatTally) {
            const best = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
            numberFormat.set(col, best ? best[0] : null);
        }
        return { rows: matrix, numberFormat, formulaCols };
    }

    /**
     * Rows 1..(headerRow + maxRows) — `maxRows` DATA rows after the header;
     * the engine asks for one more than its cap to learn it was truncated.
     */
    async function readSheet(file, sheet, { headerRow = 1, maxRows = 10000, maxCols = 100 } = {}) {
        const { sheets } = await clients();
        const tab = sheetName(sheet);
        let res;
        try {
            res = await sheets.spreadsheets.values.get({
                spreadsheetId: idOf(file),
                range: `${quoteTab(tab)}!1:${headerRow + maxRows}`,
                valueRenderOption: 'UNFORMATTED_VALUE',
                dateTimeRenderOption: 'SERIAL_NUMBER',
            });
        } catch (e) {
            throw translate(e, `sheet '${tab}'`, file, tab);
        }
        let errorCells = 0;
        const rows = (res.data.values || []).map((r) => (r || []).slice(0, maxCols).map((v) => {
            const out = readCell(v);
            if (out === null && typeof v === 'string' && ERROR_STRINGS.has(v)) errorCells += 1;
            return out;
        }));
        return { rows, errorCells };
    }

    async function readRow(file, sheet, rowNumber) {
        const { sheets } = await clients();
        const tab = sheetName(sheet);
        const n = Number(rowNumber);
        let res;
        try {
            res = await sheets.spreadsheets.values.get({
                spreadsheetId: idOf(file),
                range: `${quoteTab(tab)}!${n}:${n}`,
                valueRenderOption: 'UNFORMATTED_VALUE',
                dateTimeRenderOption: 'SERIAL_NUMBER',
            });
        } catch (e) {
            throw translate(e, `sheet '${tab}'`, file, tab);
        }
        return ((res.data.values || [])[0] || []).map(readCell);
    }

    async function batchUpdate(file, requests, what, sheet) {
        const { sheets } = await clients();
        try {
            return await sheets.spreadsheets.batchUpdate({ spreadsheetId: idOf(file), requestBody: { requests } });
        } catch (e) {
            throw translate(e, what, file, sheet);
        }
    }

    /**
     * Write the given cells of one row — one updateCells request per cell,
     * typed, `fields: 'userEnteredValue'` so the cell keeps its format.
     * @param {Array<{col:number, value:any, type:string}>} cells
     */
    async function updateCells(file, sheet, rowNumber, cells, { ifMatch = null } = {}) {
        await guard(file, ifMatch);
        const gid = await gidOf(file, sheet);
        const requests = (cells || []).map((c) => ({
            updateCells: {
                start: { sheetId: gid, rowIndex: Number(rowNumber) - 1, columnIndex: Number(c.col) },
                rows: [{ values: [{ userEnteredValue: extendedValue(c.value, c.type) }] }],
                fields: 'userEnteredValue',
            },
        }));
        if (requests.length) await batchUpdate(file, requests, 'row', sheet);
        return { marker: (await probe(file)).marker };
    }

    /** One row of the tab as values.get hands it back (typed). */
    async function rowIsBlank(file, tab, rowNumber) {
        const { sheets } = await clients();
        let res;
        try {
            res = await sheets.spreadsheets.values.get({
                spreadsheetId: idOf(file),
                range: `${quoteTab(tab)}!${rowNumber}:${rowNumber}`,
                valueRenderOption: 'UNFORMATTED_VALUE',
                dateTimeRenderOption: 'SERIAL_NUMBER',
            });
        } catch (e) {
            throw translate(e, `sheet '${tab}'`, file, tab);
        }
        const row = ((res.data && res.data.values) || [])[0] || [];
        return row.every((v) => v === null || v === undefined || v === '');
    }

    /**
     * Append one row under the engine's last DATA row (`afterRow`), or —
     * when the engine does not know it (a truncated read) — wherever
     * values.append puts it.
     *
     * Not values.append when `afterRow` is known: Sheets takes "the table"
     * to be the contiguous block from the range's corner, so a blank row
     * inside the data ends the table there, INSERT_ROWS lands the new row
     * in that gap and every row under it shifts down — while the engine
     * assumes the row went to the end and keeps `r<n>` for the rows that
     * moved. So the row is written where it belongs, by updateCells at
     * `afterRow + 1` (the grid is grown first when it ends above that: a
     * write past gridProperties.rowCount is a 400). That row is read first
     * and, should it hold anything after all, a row is INSERTED there so
     * nothing is overwritten — the guard makes that near-impossible, and
     * the engine's read of the next pass renumbers what shifted.
     * Date columns then get a DATE / DATE_TIME number format so the serial
     * renders as a date.
     * @returns {{ rowNumber:number, marker:object }}
     */
    async function appendRow(file, sheet, cells, { ifMatch = null, afterRow = null } = {}) {
        await guard(file, ifMatch);
        const tab = sheetName(sheet);
        let rowNumber;
        if (afterRow != null && Number.isInteger(Number(afterRow)) && Number(afterRow) >= 0) {
            const gid = await gidOf(file, sheet);
            const meta = (await listSheets(file)).find((s) => s.id === gid) || null;
            rowNumber = Number(afterRow) + 1;
            const requests = [];
            const beyondGrid = meta && meta.rowCount != null && rowNumber > meta.rowCount;
            if (beyondGrid) {
                requests.push({ appendDimension: { sheetId: gid, dimension: 'ROWS', length: rowNumber - meta.rowCount } });
            } else if (!(await rowIsBlank(file, tab, rowNumber))) {
                requests.push({ insertDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }, inheritFromBefore: true } });
            }
            for (const c of cells || []) {
                requests.push({
                    updateCells: {
                        start: { sheetId: gid, rowIndex: rowNumber - 1, columnIndex: Number(c.col) },
                        rows: [{ values: [{ userEnteredValue: extendedValue(c.value, c.type) }] }],
                        fields: 'userEnteredValue',
                    },
                });
            }
            if (requests.length) await batchUpdate(file, requests, 'row', sheet);
        } else {
            const { sheets } = await clients();
            const width = (cells || []).reduce((m, c) => Math.max(m, Number(c.col) + 1), 0);
            const row = new Array(width).fill(null);
            for (const c of cells || []) row[Number(c.col)] = rawValue(c.value, c.type);
            let res;
            try {
                res = await sheets.spreadsheets.values.append({
                    spreadsheetId: idOf(file),
                    range: `${quoteTab(tab)}!A1`,
                    valueInputOption: 'RAW',
                    insertDataOption: 'INSERT_ROWS',
                    requestBody: { values: [row] },
                });
            } catch (e) {
                throw translate(e, `sheet '${tab}'`, file, tab);
            }
            rowNumber = rowNumberOfRange(res.data && res.data.updates && res.data.updates.updatedRange);
            if (!rowNumber) {
                throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', 'Google Sheets did not say where the new row landed.', { ref: refOf(file) });
            }
        }
        const dateCols = (cells || []).filter((c) => c.type === 'date' || c.type === 'datetime');
        if (dateCols.length) {
            const gid = await gidOf(file, sheet);
            await batchUpdate(file, dateCols.map((c) => ({
                repeatCell: {
                    range: { sheetId: gid, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: Number(c.col), endColumnIndex: Number(c.col) + 1 },
                    cell: { userEnteredFormat: { numberFormat: c.type === 'datetime' ? { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' } : { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
                    fields: 'userEnteredFormat.numberFormat',
                },
            })), 'row', sheet);
        }
        return { rowNumber, marker: (await probe(file)).marker };
    }

    async function deleteRow(file, sheet, rowNumber, { ifMatch = null } = {}) {
        await guard(file, ifMatch);
        const gid = await gidOf(file, sheet);
        const n = Number(rowNumber);
        await batchUpdate(file, [{
            deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: n - 1, endIndex: n } },
        }], 'row', sheet);
        return { marker: (await probe(file)).marker };
    }

    const cells = {
        /** Cell-precise access exists for native Sheets only. */
        available: async (file) => (file && (file.format || formatOf(file))) === 'gsheet',
        listSheets, sample, readSheet, readRow, updateCells, appendRow, deleteRow,
    };

    return { provider, list, probe, download, upload, markerEquals, cells };
}

/** Cheap: a vault row or session tokens for Google — no provider call. */
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
    toFileRef, extendedValue, rawValue, colLetter, quoteTab, escapeQ, rowNumberOfRange, FILE_FIELDS,
};
