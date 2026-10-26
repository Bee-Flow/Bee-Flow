// @typecheck strict
/**
 * The guard that runs on an uploaded workbook package (xlsx, xlsm, ods) BEFORE
 * the spreadsheet parser sees a single byte of it.
 *
 * An uploaded file is untrusted. Three things can go wrong with a zip package:
 *   - a zip bomb: a few kilobytes that inflate to gigabytes;
 *   - an XML bomb or external entity: a DOCTYPE or ENTITY declaration in one of
 *     the XML parts (entity expansion, XXE);
 *   - a package that is not a workbook at all (a text document, a presentation).
 * So this module opens the package with JSZip, reads only what the zip itself
 * declares (entry count, sizes) and rejects on those, then inflates EVERY part
 * as a stream, counting bytes as they come in and cutting a part off at the first
 * chunk that breaks its declared size or a cap (the declarations are never
 * trusted), and refuses any XML part that declares a DOCTYPE or an ENTITY.
 * Macros (vbaProject.bin) are never run and never kept: only cell values leave
 * the reader.
 *
 * Every refusal carries errorClass 'table_source_rejected' (or
 * 'table_source_unsupported' for a package that is no workbook) and a sentence
 * that names a cap, never a byte of content.
 */

'use strict';

const JSZip = require('jszip');

const MAX_ENTRIES = 10_000;
const MAX_RATIO = 200;
const RATIO_FLOOR_BYTES = 10 * 1024 * 1024;
const ODS_MIMETYPE = /^application\/vnd\.oasis\.opendocument\.spreadsheet(-template)?$/;
// The needles an XML part must not hold, in the encodings a part may use.
const FORBIDDEN = ['<!DOCTYPE', '<!ENTITY'];
const FORBIDDEN_BYTES = FORBIDDEN.flatMap(s => [Buffer.from(s, 'utf8'), Buffer.from(s, 'utf16le')]);
const XML_PART_RE = /\.(xml|rels)$/i;
const MIB = 1024 * 1024;

/**
 * @param {string} errorClass
 * @param {string} message
 */
function sourceError(errorClass, message) {
    return Object.assign(new Error(message), { errorClass });
}

/**
 * @param {string} message
 */
function rejected(message) {
    return sourceError('table_source_rejected', message);
}

/**
 * The entry count the zip's end-of-central-directory record declares, read
 * without opening the package: a count past the cap is refused before JSZip
 * allocates an entry for every one of them. null when no record is found (JSZip
 * then refuses the file by itself).
 * @param {Buffer} buffer
 */
function declaredEntryCount(buffer) {
    const lowest = Math.max(0, buffer.length - 22 - 0xffff);
    for (let i = buffer.length - 22; i >= lowest; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) return buffer.readUInt16LE(i + 10);
    }
    return null;
}

/**
 * @param {any} entry  a JSZip entry
 * @returns {{ uncompressed: number, compressed: number }}
 */
function declaredSizes(entry) {
    const d = entry && entry._data;
    return {
        uncompressed: d && Number.isFinite(d.uncompressedSize) ? d.uncompressedSize : 0,
        compressed: d && Number.isFinite(d.compressedSize) ? d.compressedSize : 0,
    };
}

/**
 * The checks that need only the zip's own declarations.
 * @param {JSZip.JSZipObject[]} entries
 * @param {number} maxUncompressedBytes
 */
function checkDeclarations(entries, maxUncompressedBytes) {
    if (entries.length > MAX_ENTRIES) {
        throw rejected(`This file holds more than ${MAX_ENTRIES.toLocaleString('en-US')} parts, which is not a normal workbook, so it was not opened.`);
    }
    let total = 0;
    for (const entry of entries) {
        if (entry.dir) continue;
        const { uncompressed, compressed } = declaredSizes(entry);
        total += uncompressed;
        if (maxUncompressedBytes > 0 && total > maxUncompressedBytes) {
            throw rejected(`This file would unpack to more than ${Math.round(maxUncompressedBytes / MIB)} MB, so it was not opened. `
                + 'An administrator can raise the limit with AUTOMATION_TABLE_MAX_UNCOMPRESSED_BYTES (0 = unlimited).');
        }
        if (uncompressed > RATIO_FLOOR_BYTES && compressed > 0 && uncompressed / compressed > MAX_RATIO) {
            throw rejected('This file contains a part that is compressed far more than any real workbook is, so it was not opened.');
        }
    }
    return total;
}

const XML_REFUSED = 'This file declares an XML document type or entity, which a normal workbook never does, so it was not opened.';
const NEEDLE_TAIL = Math.max(...FORBIDDEN_BYTES.map(b => b.length)) - 1;

/**
 * Inflate one part as a stream, never in full. `onChunk` sees every chunk the
 * moment it exists and may throw to stop the part: the stream is paused at once,
 * so a part that lies about its size is cut off after one chunk instead of
 * filling memory first.
 * @param {any} entry  a JSZip entry
 * @param {(chunk: Uint8Array) => void} onChunk
 * @returns {Promise<void>}
 */
function inflateStreaming(entry, onChunk) {
    return new Promise((resolve, reject) => {
        let settled = false;
        /** @type {import('jszip').JSZipStreamHelper<Uint8Array> | undefined} */
        let helper;
        /**
         * @param {Error & { errorClass: string; }} err
         */
        const fail = (err) => {
            if (settled) return;
            settled = true;
            if (helper) helper.pause();
            reject(err);
        };
        try {
            helper = entry.internalStream('uint8array');
        } catch {
            fail(rejected('This file is not a readable package (a damaged or incomplete upload?), so it was not opened.'));
            return;
        }
        if (!helper) return; // unreachable: the catch above returned
        helper
            .on('data', (chunk) => {
                if (settled) return;
                try {
                    onChunk(chunk);
                } catch (err) {
                    fail(err);
                }
            })
            .on('error', () => fail(rejected('This file has a part that does not unpack to the size it declares, so it was not opened.')))
            .on('end', () => {
                if (settled) return;
                settled = true;
                resolve();
            })
            .resume();
    });
}

/**
 * Inflate EVERY part (not only the XML ones) as a stream and count the bytes as
 * they come in. The zip's own declarations are never trusted: a part is cut off
 * the moment it passes its declared size, the running total passes the cap, or
 * the ratio cap. XML parts are also scanned for a DOCTYPE or ENTITY, across
 * chunk borders, without being kept in memory.
 * @param {JSZip.JSZipObject[]} entries
 * @param {number} maxUncompressedBytes
 */
async function scanParts(entries, maxUncompressedBytes) {
    let running = 0;
    for (const entry of entries) {
        if (entry.dir) continue;
        const { uncompressed, compressed } = declaredSizes(entry);
        const isXml = XML_PART_RE.test(entry.name);
        let seen = 0;
        let tail = Buffer.alloc(0);
        await inflateStreaming(entry, (chunk) => {
            seen += chunk.length;
            running += chunk.length;
            if (seen > uncompressed) {
                throw rejected('This file has a part that unpacks to more than it declares, so it was not opened.');
            }
            if (maxUncompressedBytes > 0 && running > maxUncompressedBytes) {
                throw rejected(`This file unpacked to more than ${Math.round(maxUncompressedBytes / MIB)} MB, so it was not opened. `
                    + 'An administrator can raise the limit with AUTOMATION_TABLE_MAX_UNCOMPRESSED_BYTES (0 = unlimited).');
            }
            if (seen > RATIO_FLOOR_BYTES && compressed > 0 && seen / compressed > MAX_RATIO) {
                throw rejected('This file contains a part that is compressed far more than any real workbook is, so it was not opened.');
            }
            if (!isXml) return;
            const window = tail.length ? Buffer.concat([tail, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
            if (FORBIDDEN_BYTES.some(needle => window.includes(needle))) throw rejected(XML_REFUSED);
            tail = Buffer.from(window.subarray(Math.max(0, window.length - NEEDLE_TAIL)));
        });
    }
}

/**
 * The container kind from the package's own markers.
 * @param {JSZip} zip
 */
async function packageKind(zip) {
    const mimetype = zip.file('mimetype');
    if (mimetype) {
        const text = (await mimetype.async('string')).trim();
        if (ODS_MIMETYPE.test(text)) return 'ods';
    }
    const types = zip.file('[Content_Types].xml');
    if (types) {
        const xml = await types.async('string');
        if (/ms-excel\.sheet\.macroEnabled\.main\+xml/.test(xml)) return 'xlsm';
        if (/spreadsheetml\.(sheet|template)\.main\+xml/.test(xml)) return 'xlsx';
    }
    return null;
}

/**
 * Open a zip package, refuse anything that looks like a bomb or an entity
 * attack, and say what kind of workbook it is.
 *
 * @param {Buffer} buffer
 * @param {{ maxUncompressedBytes?: number }} [limits]
 * @returns {Promise<{ kind: 'xlsx'|'xlsm'|'ods' }>}
 */
async function assertSafePackage(buffer, limits = {}) {
    const maxUncompressedBytes = Number(limits.maxUncompressedBytes) || 0;
    const declared = declaredEntryCount(buffer);
    if (declared !== null && declared > MAX_ENTRIES) {
        throw rejected(`This file holds more than ${MAX_ENTRIES.toLocaleString('en-US')} parts, which is not a normal workbook, so it was not opened.`);
    }
    /** @type {JSZip} */
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer);
    } catch {
        throw rejected('This file is not a readable package (a damaged or incomplete upload?), so it was not opened.');
    }
    const entries = Object.values(zip.files);
    checkDeclarations(entries, maxUncompressedBytes);
    // Stream-inflate everything first: packageKind below reads two parts in full.
    await scanParts(entries, maxUncompressedBytes);
    const kind = await packageKind(zip);
    if (!kind) {
        throw sourceError('table_source_unsupported', 'This file is a zip package but not a spreadsheet (no workbook part was found).');
    }
    return { kind };
}

module.exports = { assertSafePackage, sourceError, MAX_ENTRIES, MAX_RATIO };
