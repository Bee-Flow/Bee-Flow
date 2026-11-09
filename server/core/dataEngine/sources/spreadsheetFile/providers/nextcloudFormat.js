// @typecheck strict
/**
 * Nextcloud Files vocabulary for ./nextcloudFiles.js: path normalisation, the
 * etag marker, the PROPFIND entry -> FileRef mapping and the scope refusal.
 * Pure: no client, no I/O.
 */

'use strict';

const { SpreadsheetSourceError } = require('../errors');
const { formatOf } = require('./index');
const documents = require('./documents');

/** @typedef {import('./index').FileRef} FileRef */
/**
 * A webdav.parsePropfind entry (integrations/nextcloudFiles/webdav.js).
 * @typedef {{ name?: string, path: string, type?: string, size?: number, contentType?: string|null, modified?: string|null,
 *             fileId?: string|number|null, etag?: string|null, permissions?: string|null, ownerId?: string|null }} NcEntry
 */
/** @typedef {{ etag: string|null, modified: string|null, size: number|null, fileId: string|null }} NcMarker */

const provider = 'nextcloud_files';

/**
 * @param {string} p
 */
function normalizePath(p) {
    const s = ('/' + String(p || '')).replace(/\/+/g, '/').replace(/\/+$/, '');
    return s || '/';
}

/**
 * The ref a refusal carries. On Nextcloud the wire id IS the path (what the browser hands out and a wizard keys on).
 * @param {{ path?: string|null }} file
 */
function refOf(file) {
    const path = file && file.path || null;
    return { provider, fileId: path, path };
}

/**
 * RFC 1123 (getlastmodified) → ISO, or null when unparsable.
 * @param {string | number | Date | null | undefined} rfc
 */
function isoOf(rfc) {
    if (!rfc) return null;
    const d = new Date(rfc);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {NcEntry} entry
 * @returns {NcMarker}
 */
function markerOf(entry) {
    return {
        etag: entry.etag || null,
        modified: isoOf(entry.modified),
        size: entry.size != null && !Number.isNaN(entry.size) ? Number(entry.size) : null,
        fileId: entry.fileId != null ? String(entry.fileId) : null,
    };
}

/**
 * @param {{ etag?: string|null }} a
 * @param {{ etag?: string|null }} b
 */
function markerEquals(a, b) {
    return !!a && !!b && a.etag != null && a.etag === b.etag;
}

/**
 * The format of a file entry: a spreadsheet's, or in documents mode any readable document's.
 * @param {NcEntry} entry
 * @param {boolean} asDocuments
 */
function formatOfEntry(entry, asDocuments) {
    const file = { name: entry.name, mimeType: entry.contentType };
    return asDocuments ? documents.documentFormatOf(file) : formatOf(file);
}

/**
 * @param {NcEntry} entry
 * @returns {number | null}
 */
function sizeOf(entry) {
    return entry.size == null ? null : Number(entry.size);
}

/**
 * The deep link of an entry, from the public URL (null = no link).
 * @param {NcEntry} entry
 * @param {string | null | undefined} linkBase
 */
function webUrlOf(entry, linkBase) {
    return linkBase && entry.fileId != null ? `${linkBase}/f/${entry.fileId}` : null;
}

/**
 * The file id (oc:fileid) as text.
 * @param {NcEntry} entry
 */
function idOf(entry) {
    return entry.fileId != null ? String(entry.fileId) : null;
}

/**
 * Nextcloud's permission string carries a W when the file may be written (a folder says C/K: files
 * may be created in it).
 * @param {NcEntry} entry
 * @param {boolean} isFolder
 */
function writableOf(entry, isFolder) {
    if (entry.permissions == null) return true;
    const p = String(entry.permissions);
    return isFolder ? (p.includes('C') || p.includes('K')) : p.includes('W');
}

/**
 * A parsePropfind entry → FileRef. Non-spreadsheet files are dropped (in documents mode, `accept:
 * 'documents'`, the files the knowledge-base extractor cannot read; the ref then carries its change
 * `marker`). `linkBase` is the public URL (null = no deep link).
 * @param {NcEntry} entry
 * @param {{ baseUrl: string, uid: string, linkBase?: string|null, accept?: string|null }} opts
 */
function toFileRef(entry, { baseUrl, uid, linkBase = baseUrl, accept = null }) {
    if (!entry) return null;
    const isFolder = entry.type === 'folder';
    const asDocuments = documents.isDocumentsMode(accept);
    const format = isFolder ? null : formatOfEntry(entry, asDocuments);
    if (!isFolder && !format) return null;
    const path = normalizePath(entry.path);
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    return {
        provider,
        fileId: idOf(entry),
        driveId: /** @type {string|null} */ (null),
        path,
        name: entry.name || path.split('/').pop() || '',
        mimeType: entry.contentType || null,
        format,
        size: isFolder ? null : sizeOf(entry),
        modifiedAt: isoOf(entry.modified),
        etag: entry.etag || null,
        webUrl: webUrlOf(entry, linkBase),
        parentId: parent,
        isFolder,
        owned: !!entry.ownerId && entry.ownerId === uid,
        writable: writableOf(entry, isFolder),
        ...(asDocuments ? { marker: markerOf(entry) } : {}),
    };
}

/**
 * @param {{ path?: string|null }} source
 * @param {string} verb
 */
function scopeDenied(source, verb) {
    return new SpreadsheetSourceError(403, 'nc_scope_denied',
        verb === 'write'
            ? 'This folder is not shared for writing with Bee Flow by the account that linked this table.'
            : 'This file is not shared with Bee Flow by the account that linked this table.',
        { ref: refOf(source) });
}


module.exports = { provider, normalizePath, refOf, isoOf, markerOf, markerEquals, toFileRef, scopeDenied };
