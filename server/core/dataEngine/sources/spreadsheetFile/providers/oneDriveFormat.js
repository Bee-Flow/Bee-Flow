// @typecheck noImplicitAny
/**
 * OneDrive / Graph vocabulary for ./oneDrive.js and ./oneDriveWorkbook.js:
 * the select lists and limits, A1 addresses, the driveItem -> FileRef
 * mapping, the cTag marker, the refusal ref, the Graph error body, and the
 * workbook value and number-format codecs. Pure apart from reading an error
 * Response's body.
 */

'use strict';

const { formulaShaped } = require('../cells');
const { formatOf } = require('./index');
const { fallback } = require('../../../../../utils/bestEffort');

/** @typedef {import('./index').FileRef} FileRef */
/**
 * A Graph driveItem, the ITEM_SELECT / PROBE_SELECT fields of it.
 * @typedef {{ id?: string, name?: string, size?: number, eTag?: string, cTag?: string, lastModifiedDateTime?: string,
 *             file?: { mimeType?: string }, folder?: object, webUrl?: string, deleted?: object,
 *             parentReference?: { driveId?: string, id?: string, path?: string },
 *             remoteItem?: DriveItem, '@microsoft.graph.downloadUrl'?: string }} DriveItem
 */
/** @typedef {{ eTag: string|null, cTag: string|null, lastModifiedDateTime: string|null, size: number|null }} GraphMarker */

const provider = 'onedrive';
const oauthProvider = 'microsoft';
const integrationAppIds = ['onedrive'];

const PAGE_SIZE = 50;
const ITEM_SELECT = 'id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,webUrl,parentReference,remoteItem';
const PROBE_SELECT = 'id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,webUrl,parentReference,deleted,@microsoft.graph.downloadUrl';
/** Graph refuses a simple PUT …/content above this; larger bodies go through an upload session. */
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Upload-session ranges must be multiples of 320 KiB; 10 of them per PUT. */
const UPLOAD_CHUNK = 10 * 320 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Excel serial number formats: a d/m/y token outside a [colour] or literal. */
const DATE_FORMAT_RE = /[dmy]/i;
const TIME_FORMAT_RE = /[hs]|AM\/PM/i;

/**
 * 0-based column → letter(s).
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

/**
 * `Sheet1!C3:F20` → { sheet, first:{col,row}, last:{col,row} } (1-based rows, 0-based cols).
 * @param {string|null|undefined} address
 */
function parseAddress(address) {
    const s = String(address || '');
    const bang = s.lastIndexOf('!');
    const range = bang >= 0 ? s.slice(bang + 1) : s;
    const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(range);
    if (!m) return null;
    const col = (/** @type {string} */ l) => l.toUpperCase().split('').reduce((/** @type {number} */ acc, /** @type {string} */ ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
    const first = { col: col(m[1]), row: Number(m[2]) };
    const last = m[3] ? { col: col(m[3]), row: Number(m[4]) } : { ...first };
    return { sheet: bang >= 0 ? s.slice(0, bang).replace(/^'|'$/g, '') : null, first, last };
}

/**
 * The ref a refusal carries. Its id is the browser's own: an item outside
 * the own drive keeps its `drive|item` spelling, so a wizard mark keyed on
 * that id lands. "Outside" is `driveId !== ownDriveId` once the own drive
 * is known (every api call learns it first); before that, a `driveId` on
 * the ref is the client's composite id echoed back.
 * @param {FileRef} file
 * @param {string|null} [ownDriveId]
 */
function refusalRef(file, ownDriveId = null) {
    const id = file && (file.fileId || file.id) || null;
    const driveId = file && file.driveId || null;
    const foreign = !!driveId && (ownDriveId ? driveId !== ownDriveId : file.owned !== true);
    return { provider, fileId: id && foreign ? `${driveId}|${id}` : id };
}

/**
 * @param {DriveItem} item
 * @returns {GraphMarker}
 */
function markerOf(item) {
    return {
        eTag: item.eTag || null,
        cTag: item.cTag || null,
        lastModifiedDateTime: item.lastModifiedDateTime || null,
        size: item.size != null ? Number(item.size) : null,
    };
}

/**
 * @param {{ cTag?: string|null }} a
 * @param {{ cTag?: string|null }} b
 */
function markerEquals(a, b) {
    return !!a && !!b && a.cTag != null && a.cTag === b.cTag;
}

/**
 * `/drive/root:/Documents/Q3` + name → `/Documents/Q3/name`.
 * @param {DriveItem} item
 */
function pathOf(item) {
    const pr = item.parentReference || {};
    const raw = typeof pr.path === 'string' ? pr.path : null;
    if (raw === null) return null;
    const idx = raw.indexOf(':');
    const folder = idx >= 0 ? raw.slice(idx + 1) : '';
    let decoded = folder;
    try { decoded = decodeURIComponent(folder); } catch (err) { fallback('core/dataEngine/sources/spreadsheetFile/providers/oneDriveFormat:pathOf', err); /* keep raw */ }
    return `${decoded.replace(/\/$/, '')}/${item.name || ''}`;
}

/**
 * A driveItem → FileRef. A sharedWithMe entry is a stub whose real data is
 * under `remoteItem`; the ref then points at the remote drive + id.
 * @param {DriveItem} item
 * @param {{ ownDriveId?: string|null, parentId?: string|null }} [opts]
 * @returns {FileRef|null} null for anything that is neither a folder nor a spreadsheet
 */
function toFileRef(item, { ownDriveId = null, parentId = null } = {}) {
    if (!item) return null;
    const src = item.remoteItem ? { ...item.remoteItem, name: item.remoteItem.name || item.name } : item;
    if (!src.id) return null;
    const driveId = (src.parentReference && src.parentReference.driveId) || (item.remoteItem ? null : ownDriveId);
    const isFolder = !!src.folder;
    const mimeType = (src.file && src.file.mimeType) || null;
    const format = isFolder ? null : formatOf({ name: src.name, mimeType });
    if (!isFolder && !format) return null;
    return {
        provider,
        fileId: src.id,
        driveId: driveId || null,
        path: pathOf(src),
        name: src.name || '',
        mimeType,
        format,
        size: src.size != null ? Number(src.size) : null,
        modifiedAt: src.lastModifiedDateTime || null,
        etag: src.eTag || null,
        webUrl: src.webUrl || null,
        parentId: (src.parentReference && src.parentReference.id) || parentId || null,
        isFolder,
        owned: !item.remoteItem && !!driveId && driveId === ownDriveId,
    };
}

/**
 * Read a Graph error body → { code, message } (both may be empty).
 * @param {Response} res
 */
async function graphError(res) {
    const text = await res.text().catch(/** @returns {string} */ () => '');
    try {
        const j = JSON.parse(text);
        return { code: (j.error && j.error.code) || null, message: (j.error && j.error.message) || text };
    } catch (_) {
        return { code: null, message: text };
    }
}

/**
 * The value a workbook cell is written as: serials for dates, "" to clear (null = "leave as is" in Graph).
 * @param {unknown} value
 * @param {string} type
 */
function workbookValue(value, type) {
    if (value === null || value === undefined || value === '') return '';
    switch (type) {
        case 'number':
        case 'date':
        case 'datetime': {
            const n = Number(value);
            return Number.isFinite(n) ? n : String(value);
        }
        case 'bool':
            return value === true || value === 'true' || value === 1;
        default:
            return String(value);
    }
}

/**
 * Must this cell be typed Text before the value lands? Excel's Range.values
 * parses a string starting with = + - @ (or a tab / CR) as a formula — the
 * one rule every writer shares (cells.formulaShaped): only text-shaped
 * columns; a number column's -5 is a number.
 * @param {unknown} value
 * @param {string} type
 */
function needsTextFormat(value, type) {
    return formulaShaped(value, type);
}

/**
 * The number format a written cell needs: dates render their serial; a formula-shaped text is pinned as Text.
 * @param {string} type
 * @param {unknown} value
 */
function workbookFormat(type, value) {
    if (type === 'date') return 'yyyy-mm-dd';
    if (type === 'datetime') return 'yyyy-mm-dd hh:mm';
    if (needsTextFormat(value, type)) return '@';
    return null;
}

module.exports = {
    provider, oauthProvider, integrationAppIds,
    PAGE_SIZE, ITEM_SELECT, PROBE_SELECT, SIMPLE_UPLOAD_MAX, UPLOAD_CHUNK, DOWNLOAD_TIMEOUT_MS,
    DATE_FORMAT_RE, TIME_FORMAT_RE,
    colLetter, parseAddress, refusalRef, markerOf, markerEquals, pathOf, toFileRef, graphError,
    workbookValue, needsTextFormat, workbookFormat,
};
