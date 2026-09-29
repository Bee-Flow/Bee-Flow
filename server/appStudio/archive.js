/**
 * Opening a customer's archive — what kind is it, and what is inside.
 *
 * The intake used to know exactly one container: a zip, opened inline. That is
 * the shape most orders arrive in and it is not the only one. A forwarded mail
 * carries a zip inside a zip; a Windows user who "zipped the project folder"
 * sends a .7z because that is what their context menu offered; a Linux customer
 * sends a .tar.gz; and somebody eventually sends an archive with a password on
 * it. Today all four end the same way — a file that sits in the attachment list
 * doing nothing, or a refusal that says "could not open the zip" about something
 * that is not broken at all.
 *
 * This module answers two questions and refuses to guess at either:
 *
 *   archiveFormat(bytes, name)  — WHAT is this? Magic bytes first, the filename
 *                                 only as a tiebreak. A sender-chosen extension
 *                                 is a claim; the first six bytes are evidence.
 *   openArchive(bytes, format)  — the entries, as one uniform list, whatever the
 *                                 container was.
 *
 * NO NEW DEPENDENCIES. Zip is JSZip, which the intake already used; tar and
 * tar.gz are the built-in zlib plus a header reader short enough to audit. That
 * matters more here than convenience: this code runs on bytes a stranger mailed
 * in, and every archiver added is a parser written by somebody else with the
 * same input. 7z and RAR are therefore RECOGNISED and named — an operator is
 * told which format arrived and that it could not be opened, which is a
 * different thing from a file silently doing nothing.
 *
 * Every ceiling the caller enforces per entry still applies: this module only
 * enumerates, it never stores.
 */

'use strict';

const zlib = require('zlib');

// A gunzipped tar is held in memory whole, so this is the real ceiling on what
// one .tar.gz may cost us. Matches the intake's own per-archive budget.
const MAX_INFLATED_BYTES = 100 * 1024 * 1024;

// tar is 512-byte blocks all the way down.
const TAR_BLOCK = 512;

const ARCHIVE_EXTENSIONS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

/** Formats we can actually enumerate. The rest are recognised and named. */
const OPENABLE_FORMATS = new Set(['zip', 'tar', 'gzip']);

function startsWith(buffer, bytes, offset = 0) {
    if (!Buffer.isBuffer(buffer) || buffer.length < offset + bytes.length) return false;
    for (let i = 0; i < bytes.length; i += 1) if (buffer[offset + i] !== bytes[i]) return false;
    return true;
}

const SIGNATURES = [
    { format: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
    { format: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] },     // empty archive
    { format: 'zip', bytes: [0x50, 0x4b, 0x07, 0x08] },     // spanned
    { format: 'gzip', bytes: [0x1f, 0x8b] },
    { format: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
    { format: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
    { format: 'bzip2', bytes: [0x42, 0x5a, 0x68] },
    { format: 'xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
];

/**
 * What this archive really is — bytes first, name second.
 *
 * Returns null for anything that is not an archive at all, so a caller can tell
 * "not an archive" from "an archive I cannot open".
 */
function archiveFormat(buffer, name = '') {
    for (const sig of SIGNATURES) {
        if (startsWith(buffer, sig.bytes)) return sig.format;
    }
    // A tar has no leading signature at all; its marker sits inside the first
    // header block, which is why it has to be looked for rather than matched.
    if (startsWith(buffer, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) return 'tar';
    // Only now the name, and only for the one format whose bytes carry no
    // signature at all: a pre-POSIX tar has no "ustar" marker anywhere. For
    // every other container the magic bytes are reliable, and a name that
    // disagrees with them is a claim we have no reason to believe.
    const ext = String(name || '').toLowerCase().split('.').pop();
    return ext === 'tar' ? 'tar' : null;
}

/** Does this filename claim to be an archive? Used to decide about recursion. */
function looksLikeArchiveName(name) {
    const lower = String(name || '').toLowerCase();
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
    return ARCHIVE_EXTENSIONS.has(ext);
}

/**
 * Is this zip locked?
 *
 * Bit 0 of the general purpose flag in a local file header. Worth its twenty
 * lines: without it a password-protected archive fails somewhere deep inside
 * the reader and surfaces as "could not open the zip", which sends an operator
 * looking for a corrupt file instead of writing one sentence back to the
 * customer.
 */
function zipIsEncrypted(buffer) {
    if (!Buffer.isBuffer(buffer)) return false;
    // The first local file header; an empty archive has none and is not locked.
    for (let i = 0; i + 8 <= buffer.length && i < 1024; i += 1) {
        if (!startsWith(buffer, [0x50, 0x4b, 0x03, 0x04], i)) continue;
        return (buffer.readUInt16LE(i + 6) & 0x01) === 1;
    }
    return false;
}

/** Octal header field → number; tar pads with spaces and NULs, both of which end it. */
function octal(buffer, offset, length) {
    let text = '';
    for (let i = offset; i < offset + length && i < buffer.length; i += 1) {
        const c = buffer[i];
        if (c === 0 || c === 0x20) break;
        text += String.fromCharCode(c);
    }
    const n = parseInt(text, 8);
    return Number.isFinite(n) ? n : 0;
}

function nulString(buffer, offset, length) {
    let end = offset;
    const limit = Math.min(offset + length, buffer.length);
    while (end < limit && buffer[end] !== 0) end += 1;
    return buffer.toString('utf8', offset, end);
}

/**
 * Entries of an (already decompressed) tar.
 *
 * Handles the two things real tars do that a naive reader gets wrong: the ustar
 * `prefix` field, which is where a long path's leading directories actually
 * live, and GNU's 'L' entry, whose CONTENT is the name of the entry after it.
 * Everything else — pax headers, hard links, devices — is skipped by type, not
 * mistaken for a file.
 */
function tarEntries(buffer) {
    const out = [];
    let offset = 0;
    let longName = null;
    while (offset + TAR_BLOCK <= buffer.length) {
        const header = buffer.subarray(offset, offset + TAR_BLOCK);
        // Two consecutive zero blocks end the archive; one is enough for us.
        if (header.every((b) => b === 0)) break;
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 0x30);
        const dataAt = offset + TAR_BLOCK;
        const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

        if (type === 'L') {                     // GNU long name: names the NEXT entry
            longName = nulString(buffer, dataAt, size).replace(/\0+$/, '');
        } else if (type === '0' || type === '\0' || type === '7') {
            const prefix = nulString(header, 345, 155);
            const name = nulString(header, 0, 100);
            const path = longName || (prefix ? `${prefix}/${name}` : name);
            longName = null;
            if (path) out.push({ path, size, at: dataAt });
        } else {
            longName = type === 'x' || type === 'g' ? longName : null;
        }
        // Always at least one block forward, so a malformed size cannot spin.
        offset = dataAt + padded;
    }
    return out.map((e) => ({
        path: e.path,
        size: e.size,
        isDir: e.path.endsWith('/'),
        read: async () => buffer.subarray(e.at, e.at + e.size),
    }));
}

/**
 * Enumerate an archive.
 *
 *   → { format, entries: [{ path, size, isDir, read() }], dirs: [paths] }
 *
 * Throws an Error carrying `.reason` — a sentence fit to show an operator —
 * for the archives we recognise and cannot open, so a caller never has to
 * invent a message from a stack trace.
 */
async function openArchive(buffer, { name = '', JSZip = null } = {}) {
    const format = archiveFormat(buffer, name);
    if (!format) {
        const err = new Error('not an archive');
        // The caller only ever gets here for a file whose NAME claims to be an
        // archive, so "not an archive" alone reads as a contradiction. Damaged
        // is the likelier truth and the one worth acting on.
        err.reason = 'this file is damaged or is not an archive';
        throw err;
    }
    if (!OPENABLE_FORMATS.has(format)) {
        const err = new Error(`${format} not supported`);
        // Named, and named ACCURATELY. "Could not open the zip" about a .7z is
        // worse than saying nothing: it sends somebody hunting a corrupt file.
        err.reason = format === '7z' || format === 'rar'
            ? `a .${format} archive cannot be opened here — ask for a .zip`
            : `a ${format} archive cannot be opened here — ask for a .zip`;
        err.format = format;
        throw err;
    }

    if (format === 'zip') {
        if (zipIsEncrypted(buffer)) {
            const err = new Error('encrypted zip');
            err.reason = 'this zip is password-protected';
            err.format = 'zip';
            throw err;
        }
        const Z = JSZip || require('jszip');
        const zip = await Z.loadAsync(buffer);
        const all = Object.values(zip.files).filter((e) => e && !/__MACOSX/i.test(e.name));
        return {
            format,
            dirs: all.filter((e) => e.dir).map((e) => e.name),
            entries: all.filter((e) => !e.dir).map((e) => ({
                path: e.name,
                size: (e._data && e._data.uncompressedSize) || 0,
                isDir: false,
                read: () => e.async('nodebuffer'),
            })),
        };
    }

    // gzip: one member, and for an order package that member is a tar.
    let plain = buffer;
    if (format === 'gzip') {
        try {
            plain = zlib.gunzipSync(buffer, { maxOutputLength: MAX_INFLATED_BYTES });
        } catch (e) {
            const err = new Error('gunzip failed');
            err.reason = /maxOutputLength|buffer/i.test(String(e && e.message))
                ? 'this archive is too large to open here'
                : 'this .gz archive could not be opened';
            throw err;
        }
        if (!startsWith(plain, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) {
            // A lone gzipped FILE, not a tarball: one entry, named by dropping
            // the .gz — which is exactly what every unzipper does with it.
            const inner = String(name || 'bestand').replace(/[.](gz|tgz)$/i, '') || 'bestand';
            return { format, dirs: [], entries: [{ path: inner, size: plain.length, isDir: false, read: async () => plain }] };
        }
    }

    const entries = tarEntries(plain);
    return {
        format,
        dirs: entries.filter((e) => e.isDir).map((e) => e.path),
        entries: entries.filter((e) => !e.isDir),
    };
}

module.exports = {
    archiveFormat,
    looksLikeArchiveName,
    openArchive,
    zipIsEncrypted,
    OPENABLE_FORMATS,
    MAX_INFLATED_BYTES,
    _internal: { tarEntries, octal, nulString, startsWith },
};
